//! The workspace index and the cursor-driven queries on it.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};

use air_r_syntax::RSyntaxNode;
use biome_rowan::TextSize;

use crate::call::{IdentAt, Usage, call_at, ident_at, match_args};
use crate::extract::{Definition, Formal, doc_canonical, parse};
use crate::manifest::Manifest;
use crate::roxygen::Block;
use crate::text::TextMap;
use crate::{
    FileFingerprint, FunctionSummary, Hover, HoverKind, ManifestError, ParameterInfo, Range,
    SignatureHelp, content_hash, markdown,
};

/// Name lookups for one file, built on first use so that `update_file` only
/// pays for parsing.
#[derive(Debug, Default)]
pub(crate) struct FileMaps {
    pub by_name: HashMap<String, Vec<usize>>,
    pub by_rdname: HashMap<String, Vec<usize>>,
    pub by_describe: HashMap<String, Vec<usize>>,
}

/// A parsed file. The syntax tree is kept so queries never re-parse.
#[derive(Debug)]
pub(crate) struct FileEntry {
    hash: OnceCell<String>,
    doc_hash: OnceCell<String>,
    maps: OnceCell<FileMaps>,
    pub text: Box<str>,
    pub map: TextMap,
    pub root: RSyntaxNode,
    pub defs: Vec<Definition>,
}

impl FileEntry {
    /// Computed on first use: only the manifest overlay needs it.
    pub fn hash(&self) -> &str {
        self.hash.get_or_init(|| content_hash(&self.text))
    }

    /// Hash of only what can change roxygen2's output (contracts §0).
    pub fn doc_hash(&self) -> &str {
        self.doc_hash
            .get_or_init(|| content_hash(&doc_canonical(&self.text, &self.root)))
    }

    pub fn maps(&self) -> &FileMaps {
        self.maps.get_or_init(|| {
            let mut maps = FileMaps::default();
            for (i, def) in self.defs.iter().enumerate() {
                maps.by_name.entry(def.name.clone()).or_default().push(i);
                if def.block_mentions(&self.text, "@rdname")
                    && let Some(rdname) = def.block(&self.text).and_then(|b| b.rdname.as_ref())
                {
                    maps.by_rdname.entry(rdname.clone()).or_default().push(i);
                }
                if def.block_mentions(&self.text, "@describeIn")
                    && let Some(describe) =
                        def.block(&self.text).and_then(|b| b.describe_in.as_ref())
                {
                    maps.by_describe
                        .entry(describe.parent.clone())
                        .or_default()
                        .push(i);
                }
            }
            maps
        })
    }

    fn new(text: &str) -> Self {
        let parsed = parse(text);
        Self {
            hash: OnceCell::new(),
            doc_hash: OnceCell::new(),
            maps: OnceCell::new(),
            text: text.into(),
            map: TextMap::new(text),
            root: parsed.root,
            defs: parsed.defs,
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

    pub fn formals(&self) -> &'a [Formal] {
        self.def().formals()
    }

    pub fn block(&self) -> Option<&'a Block> {
        self.def().block(&self.file.text)
    }

    pub fn key(&self) -> DefKey<'a> {
        (self.path, self.idx)
    }
}

#[derive(Debug, Default)]
pub struct Index {
    files: HashMap<String, FileEntry>,
    /// Reverse maps over all files, kept in step by `update_file` and
    /// `remove_file` so queries never scan the workspace.
    by_name: HashMap<String, BTreeSet<String>>,
    by_rdname: HashMap<String, BTreeSet<(String, usize)>>,
    by_describe: HashMap<String, BTreeSet<(String, usize)>>,
    manifest: Option<Manifest>,
}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses `text` once; unchanged text is a no-op.
    pub fn update_file(&mut self, path: &str, text: &str) {
        if self.files.get(path).is_some_and(|file| *file.text == *text) {
            return;
        }
        self.remove_file(path);
        let entry = FileEntry::new(text);
        self.index_entry(path, &entry);
        self.files.insert(path.to_string(), entry);
    }

    pub fn remove_file(&mut self, path: &str) {
        if let Some(entry) = self.files.remove(path) {
            self.unindex_entry(path, &entry);
        }
    }

    fn index_entry(&mut self, path: &str, entry: &FileEntry) {
        let maps = entry.maps();
        for name in maps.by_name.keys() {
            self.by_name
                .entry(name.clone())
                .or_default()
                .insert(path.to_string());
        }
        for (target, source) in [
            (&mut self.by_rdname, &maps.by_rdname),
            (&mut self.by_describe, &maps.by_describe),
        ] {
            for (key, idxs) in source {
                target
                    .entry(key.clone())
                    .or_default()
                    .extend(idxs.iter().map(|&i| (path.to_string(), i)));
            }
        }
    }

    fn unindex_entry(&mut self, path: &str, entry: &FileEntry) {
        let maps = entry.maps();
        for name in maps.by_name.keys() {
            if let Some(paths) = self.by_name.get_mut(name) {
                paths.remove(path);
                if paths.is_empty() {
                    self.by_name.remove(name);
                }
            }
        }
        for (target, source) in [
            (&mut self.by_rdname, &maps.by_rdname),
            (&mut self.by_describe, &maps.by_describe),
        ] {
            for (key, idxs) in source {
                if let Some(set) = target.get_mut(key) {
                    for &i in idxs {
                        set.remove(&(path.to_string(), i));
                    }
                    if set.is_empty() {
                        target.remove(key);
                    }
                }
            }
        }
    }

    /// Every indexed file's hashes, ordered by path.
    pub fn fingerprints(&self) -> Vec<FileFingerprint> {
        let mut out: Vec<FileFingerprint> = self
            .files
            .iter()
            .map(|(path, file)| FileFingerprint {
                path: path.clone(),
                content_hash: file.hash().to_string(),
                doc_hash: file.doc_hash().to_string(),
            })
            .collect();
        out.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        out
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
        let signature = markdown::signature(&def.def().name, def.formals());
        let markdown = self.with_duplicate_note(
            def,
            markdown::help_page(
                &def.def().name,
                file_label(def.path),
                &signature.label,
                &doc,
            ),
        );
        Some(Hover {
            name: def.def().name.clone(),
            kind,
            markdown,
            range: self.range_in(file, ident.range),
            source: doc.source,
        })
    }

    fn hover_target<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        ident: &IdentAt,
    ) -> Option<(DefRef<'a>, HoverKind)> {
        match ident.usage {
            Usage::AssignTarget => {
                let idx = file
                    .defs
                    .binary_search_by_key(&ident.range.start(), |d| d.name_range.start())
                    .ok()?;
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
        let formals = def.formals();
        let signature = markdown::signature(&def.def().name, formals);

        let names: Vec<&str> = formals.iter().map(|f| f.name.as_str()).collect();
        let active = match_args(&names, &site.arg_names)
            .get(site.active_arg)
            .copied()
            .flatten();
        Some(SignatureHelp {
            name: def.def().name.clone(),
            parameters: formals
                .iter()
                .zip(&signature.params)
                .map(|(formal, &label)| ParameterInfo {
                    label,
                    documentation: markdown::param_doc(&doc, &formal.name),
                })
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
        let signature = markdown::signature(&def.def().name, def.formals());
        Some(self.with_duplicate_note(
            def,
            markdown::help_page(
                &def.def().name,
                file_label(def.path),
                &signature.label,
                &doc,
            ),
        ))
    }

    /// Same-named definitions are separate functions; say so when `def` has
    /// siblings in other files or elsewhere in its own file.
    fn with_duplicate_note(&self, def: DefRef<'_>, page: String) -> String {
        let name = def.def().name.as_str();
        let paths: Vec<&str> = self
            .by_name
            .get(name)
            .into_iter()
            .flatten()
            .filter(|path| {
                path.as_str() != def.path
                    || self.files[path.as_str()]
                        .maps()
                        .by_name
                        .get(name)
                        .is_some_and(|v| v.len() > 1)
            })
            .map(String::as_str)
            .collect();
        if paths.is_empty() {
            return page;
        }
        let listed = paths
            .iter()
            .map(|path| format!("`{}`", file_label(path)))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{page}\n\n*Also defined in:* {listed}")
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
        if let Some((path, file)) = local
            && let Some(&idx) = file.maps().by_name.get(name).and_then(|v| v.first())
        {
            return Some(DefRef { path, file, idx });
        }
        let path = self.by_name.get(name)?.first()?;
        let (path, file) = self.files.get_key_value(path.as_str())?;
        let idx = *file.maps().by_name.get(name)?.first()?;
        Some(DefRef { path, file, idx })
    }

    fn def_ref(&self, path: &str, idx: usize) -> Option<DefRef<'_>> {
        let (path, file) = self.files.get_key_value(path)?;
        Some(DefRef { path, file, idx })
    }

    /// Definitions whose `@rdname` is `page`.
    pub(crate) fn rdname_members(&self, page: &str) -> impl Iterator<Item = DefRef<'_>> {
        self.by_rdname
            .get(page)
            .into_iter()
            .flatten()
            .filter_map(|(path, idx)| self.def_ref(path, *idx))
    }

    /// Definitions whose `@describeIn` parent is `parent`.
    pub(crate) fn describe_members(&self, parent: &str) -> impl Iterator<Item = DefRef<'_>> {
        self.by_describe
            .get(parent)
            .into_iter()
            .flatten()
            .filter_map(|(path, idx)| self.def_ref(path, *idx))
    }

    pub(crate) fn manifest(&self) -> Option<&Manifest> {
        self.manifest.as_ref()
    }
}

fn file_label(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}
