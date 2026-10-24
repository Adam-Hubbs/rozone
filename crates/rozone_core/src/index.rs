//! The workspace index and the cursor-driven queries on it.

use std::collections::{BTreeSet, HashMap};

use air_r_syntax::RSyntaxNode;
use biome_rowan::TextSize;

use crate::call::{IdentAt, Usage, call_at, ident_at, match_args};
use crate::extract::{Definition, parse};
use crate::manifest::Manifest;
use crate::text::TextMap;
use crate::{
    FunctionSummary, Hover, HoverKind, ManifestError, ParameterInfo, Range, SignatureHelp, content_hash,
    markdown,
};

/// A parsed file. The syntax tree is kept so queries never re-parse.
#[derive(Debug)]
pub(crate) struct FileEntry {
    pub hash: String,
    pub text: String,
    pub map: TextMap,
    pub root: RSyntaxNode,
    pub defs: Vec<Definition>,
    pub by_name: HashMap<String, Vec<usize>>,
    pub by_rdname: HashMap<String, Vec<usize>>,
    pub by_describe: HashMap<String, Vec<usize>>,
}

impl FileEntry {
    fn new(text: &str) -> Self {
        let parsed = parse(text);
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_rdname: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_describe: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, def) in parsed.defs.iter().enumerate() {
            by_name.entry(def.name.clone()).or_default().push(i);
            if let Some(block) = &def.block {
                if let Some(rdname) = &block.rdname {
                    by_rdname.entry(rdname.clone()).or_default().push(i);
                }
                if let Some(describe) = &block.describe_in {
                    by_describe.entry(describe.parent.clone()).or_default().push(i);
                }
            }
        }
        Self {
            hash: content_hash(text),
            text: text.to_string(),
            map: TextMap::new(text),
            root: parsed.root,
            defs: parsed.defs,
            by_name,
            by_rdname,
            by_describe,
        }
    }
}

/// A definition located in the index.
#[derive(Clone, Copy)]
pub(crate) struct DefRef<'a> {
    pub path: &'a str,
    pub file: &'a FileEntry,
    pub idx: usize,
}

pub(crate) type DefKey<'a> = (&'a str, usize);

impl<'a> DefRef<'a> {
    pub fn def(&self) -> &'a Definition {
        &self.file.defs[self.idx]
    }

    pub fn key(&self) -> DefKey<'a> {
        (self.path, self.idx)
    }
}

#[derive(Debug, Default)]
pub struct Index {
    files: HashMap<String, FileEntry>,
    paths_by_name: HashMap<String, BTreeSet<String>>,
    paths_by_rdname: HashMap<String, BTreeSet<String>>,
    paths_by_describe: HashMap<String, BTreeSet<String>>,
    manifest: Option<Manifest>,
}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses `text` once; unchanged text is a no-op.
    pub fn update_file(&mut self, path: &str, text: &str) {
        if self.files.get(path).is_some_and(|file| file.text == text) {
            return;
        }
        self.remove_file(path);
        let file = FileEntry::new(text);
        for (keys, map) in [
            (file.by_name.keys(), &mut self.paths_by_name),
            (file.by_rdname.keys(), &mut self.paths_by_rdname),
            (file.by_describe.keys(), &mut self.paths_by_describe),
        ] {
            for key in keys {
                map.entry(key.clone()).or_default().insert(path.to_string());
            }
        }
        self.files.insert(path.to_string(), file);
    }

    pub fn remove_file(&mut self, path: &str) {
        let Some(file) = self.files.remove(path) else { return };
        for (keys, map) in [
            (file.by_name.keys(), &mut self.paths_by_name),
            (file.by_rdname.keys(), &mut self.paths_by_rdname),
            (file.by_describe.keys(), &mut self.paths_by_describe),
        ] {
            for key in keys {
                if let Some(paths) = map.get_mut(key) {
                    paths.remove(path);
                    if paths.is_empty() {
                        map.remove(key);
                    }
                }
            }
        }
    }

    /// Replaces any previous manifest. On error the previous one is kept.
    pub fn load_manifest(&mut self, json: &str) -> Result<(), ManifestError> {
        self.manifest = Some(Manifest::parse(json)?);
        Ok(())
    }

    pub fn clear_manifest(&mut self) {
        self.manifest = None;
    }

    pub fn hover(&self, path: &str, offset: u32) -> Option<Hover> {
        let file = self.files.get(path)?;
        let byte = TextSize::from(file.map.to_byte(offset));
        let ident = ident_at(&file.root, byte)?;
        let (def, kind) = self.hover_target(path, file, &ident)?;
        let doc = self.resolve(def)?;
        let signature = markdown::signature(&def.def().name, &def.def().formals);
        Some(Hover {
            name: def.def().name.clone(),
            kind,
            markdown: markdown::hover(&signature.label, &doc),
            range: self.range_in(file, ident.range),
            source: doc.source,
        })
    }

    fn hover_target<'a>(&'a self, path: &'a str, file: &'a FileEntry, ident: &IdentAt) -> Option<(DefRef<'a>, HoverKind)> {
        match ident.usage {
            Usage::AssignTarget => {
                let idx = file.defs.binary_search_by_key(&ident.range.start(), |d| d.name_range.start()).ok()?;
                let path = self.files.get_key_value(path)?.0.as_str();
                Some((DefRef { path, file, idx }, HoverKind::Definition))
            }
            Usage::Callee => Some((self.lookup(&ident.name, Some(path))?, HoverKind::Call)),
            Usage::Bare => Some((self.lookup(&ident.name, Some(path))?, HoverKind::Identifier)),
        }
    }

    pub fn signature_help(&self, path: &str, offset: u32) -> Option<SignatureHelp> {
        let file = self.files.get(path)?;
        let byte = TextSize::from(file.map.to_byte(offset));
        let site = call_at(&file.root, byte)?;
        let def = self.lookup(&site.callee, Some(path))?;
        let doc = self.resolve(def)?;
        let formals = &def.def().formals;
        let signature = markdown::signature(&def.def().name, formals);

        let names: Vec<&str> = formals.iter().map(|f| f.name.as_str()).collect();
        let active = match_args(&names, &site.arg_names).get(site.active_arg).copied().flatten();
        Some(SignatureHelp {
            name: def.def().name.clone(),
            parameters: formals
                .iter()
                .zip(&signature.params)
                .map(|(formal, &label)| ParameterInfo { label, documentation: markdown::param_doc(&doc, &formal.name) })
                .collect(),
            label: signature.label,
            documentation: markdown::summary(&doc),
            active_parameter: active.map(|i| i as u32),
            source: doc.source,
        })
    }

    /// The full documentation page for `name`, resolved as from `from_path`.
    pub fn documentation(&self, name: &str, from_path: Option<&str>) -> Option<String> {
        let def = self.lookup(name, from_path)?;
        let doc = self.resolve(def)?;
        let signature = markdown::signature(&def.def().name, &def.def().formals);
        Some(markdown::page(&def.def().name, file_label(def.path), &signature.label, &doc))
    }

    /// Every documented function in the workspace, ordered by path and position.
    pub fn documented_functions(&self) -> Vec<FunctionSummary> {
        let mut paths: Vec<&String> = self.files.keys().collect();
        paths.sort();
        let mut out = Vec::new();
        for path in paths {
            let file = &self.files[path];
            for idx in 0..file.defs.len() {
                let def = DefRef { path, file, idx };
                if let Some(title) = self.summary_title(def) {
                    out.push(FunctionSummary {
                        name: def.def().name.clone(),
                        path: path.clone(),
                        range: self.range_in(file, def.def().name_range),
                        title,
                    });
                }
            }
        }
        out
    }

    fn range_in(&self, file: &FileEntry, range: biome_rowan::TextRange) -> Range {
        Range {
            start: file.map.to_utf16(range.start().into()),
            end: file.map.to_utf16(range.end().into()),
        }
    }

    /// Same file first, otherwise the smallest path defining `name`. Within a
    /// file the first definition wins.
    pub(crate) fn lookup<'a>(&'a self, name: &str, from_path: Option<&str>) -> Option<DefRef<'a>> {
        let local = from_path.and_then(|p| self.files.get_key_value(p));
        if let Some((path, file)) = local {
            if let Some(&idx) = file.by_name.get(name).and_then(|v| v.first()) {
                return Some(DefRef { path, file, idx });
            }
        }
        let path = self.paths_by_name.get(name)?.iter().next()?;
        let (path, file) = self.files.get_key_value(path.as_str())?;
        let idx = *file.by_name.get(name)?.first()?;
        Some(DefRef { path, file, idx })
    }

    pub(crate) fn file_paths_for<'a>(
        &'a self,
        map: &'a HashMap<String, BTreeSet<String>>,
        key: &str,
    ) -> impl Iterator<Item = (&'a String, &'a FileEntry)> {
        map.get(key)
            .into_iter()
            .flatten()
            .filter_map(|path| self.files.get_key_value(path.as_str()))
    }

    pub(crate) fn paths_by_name(&self) -> &HashMap<String, BTreeSet<String>> {
        &self.paths_by_name
    }

    pub(crate) fn paths_by_rdname(&self) -> &HashMap<String, BTreeSet<String>> {
        &self.paths_by_rdname
    }

    pub(crate) fn paths_by_describe(&self) -> &HashMap<String, BTreeSet<String>> {
        &self.paths_by_describe
    }

    pub(crate) fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }
}

fn file_label(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}
