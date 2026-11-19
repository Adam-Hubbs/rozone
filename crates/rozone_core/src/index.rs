//! The workspace index and the cursor-driven queries on it.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};

use air_r_syntax::RSyntaxNode;
use biome_rowan::TextSize;

use crate::call::{IdentAt, Usage, call_at, ident_at, match_args};
use crate::extract::{DefKind, Definition, Formal, Member, MethodDef, doc_canonical, parse};
use crate::manifest::Manifest;
use crate::resolve::Resolved;
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
    /// S4 and S7 methods, by generic name; indices into `FileEntry::methods`.
    pub by_generic: HashMap<String, Vec<usize>>,
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
    pub methods: Vec<MethodDef>,
    has_ref_class: bool,
}

impl FileEntry {
    /// Whether bare names inside the file may be reference class members;
    /// computed once, as every hover asks.
    pub fn has_ref_class(&self) -> bool {
        self.has_ref_class
    }

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
            for (i, method) in self.methods.iter().enumerate() {
                maps.by_generic
                    .entry(method.generic.clone())
                    .or_default()
                    .push(i);
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
            has_ref_class: parsed.defs.iter().any(|d| d.kind == DefKind::RefClass),
            defs: parsed.defs,
            methods: parsed.methods,
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

/// What a name under the cursor refers to.
#[derive(Clone, Copy)]
pub(crate) enum Target<'a> {
    Def(DefRef<'a>),
    /// `Class$new` for an R6 class.
    New(DefRef<'a>),
    /// An R6 member reached through `x$name`. `owner` is the class in the
    /// inheritance chain that declares it.
    Member {
        class: DefRef<'a>,
        owner: DefRef<'a>,
        member: &'a Member,
    },
}

/// Everything hover, signature help and the documentation page show.
pub(crate) struct Page<'a> {
    pub name: String,
    pub path: &'a str,
    pub formals: Vec<Formal>,
    /// Replaces the `name(formals)` usage line.
    pub usage: Option<String>,
    pub doc: Resolved,
    /// Whether `name(...)` is a call to it; an R6 class is called through `$new()`.
    pub callable: bool,
    /// The definition, for the "also defined in" note.
    pub def: Option<DefRef<'a>>,
}

impl Page<'_> {
    fn usage(&self) -> String {
        self.usage
            .clone()
            .unwrap_or_else(|| markdown::signature(&self.name, &self.formals).label)
    }
}

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
    by_generic: HashMap<String, BTreeSet<(String, usize)>>,
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
            (&mut self.by_generic, &maps.by_generic),
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
            (&mut self.by_generic, &maps.by_generic),
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
        let (path, _) = self.files.get_key_value(path)?;
        let (target, kind) = self.hover_target(path, file, &ident)?;
        let page = self.page(target)?;
        let markdown = self.page_markdown(&page, matches!(target, Target::Def(_)));
        Some(Hover {
            name: page.name,
            kind,
            markdown,
            range: self.range_in(file, ident.range),
            source: page.doc.source,
        })
    }

    fn hover_target<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        ident: &IdentAt,
    ) -> Option<(Target<'a>, HoverKind)> {
        match ident.usage {
            Usage::AssignTarget => {
                let idx = file
                    .defs
                    .binary_search_by_key(&ident.range.start(), |d| d.name_range.start())
                    .ok()?;
                Some((
                    Target::Def(DefRef { path, file, idx }),
                    HoverKind::Definition,
                ))
            }
            Usage::Callee | Usage::Bare => {
                let kind = if ident.usage == Usage::Callee {
                    HoverKind::Call
                } else {
                    HoverKind::Identifier
                };
                let target =
                    match self.ref_class_member(path, file, &ident.name, ident.range.start()) {
                        Some(member) => member,
                        None => Target::Def(self.lookup(&ident.name, Some(path))?),
                    };
                Some((target, kind))
            }
            Usage::Slot => Some((
                self.slot_target(path, &ident.name, ident.receiver.as_ref()?)?,
                HoverKind::Identifier,
            )),
            Usage::Member | Usage::MemberCallee => {
                let target =
                    self.member_target(path, file, &ident.name, ident.receiver.as_ref()?)?;
                let kind = if ident.usage == Usage::MemberCallee {
                    HoverKind::Call
                } else {
                    HoverKind::Identifier
                };
                Some((target, kind))
            }
        }
    }

    pub fn signature_help(&self, path: &str, offset: u32) -> Option<SignatureHelp> {
        let file = self.files.get(path)?;
        let byte = TextSize::from(file.map.to_byte(offset));
        let site = call_at(&file.root, byte)?;
        let (path, _) = self.files.get_key_value(path)?;
        let target = match &site.receiver {
            None => match self.ref_class_member(path, file, &site.callee, byte) {
                Some(member) => member,
                None => Target::Def(self.lookup(&site.callee, Some(path))?),
            },
            Some(receiver) => self.member_target(path, file, &site.callee, receiver)?,
        };
        let page = self.page(target)?;
        if !page.callable {
            return None;
        }
        let signature = markdown::signature(&page.name, &page.formals);
        let names: Vec<&str> = page.formals.iter().map(|f| f.name.as_str()).collect();
        let active = match_args(&names, &site.arg_names)
            .get(site.active_arg)
            .copied()
            .flatten();
        Some(SignatureHelp {
            parameters: page
                .formals
                .iter()
                .zip(&signature.params)
                .map(|(formal, &label)| ParameterInfo {
                    label,
                    documentation: markdown::param_doc(&page.doc, &formal.name),
                })
                .collect(),
            label: signature.label,
            documentation: markdown::summary(&page.doc),
            active_parameter: active.map(|i| i as u32),
            source: page.doc.source,
            name: page.name,
        })
    }

    /// The full documentation page for `name`, resolved as from `from_path`.
    /// `Class$member`, `Class$new` and `Class@slot`, the names member hovers
    /// report, work too.
    pub fn documentation(&self, name: &str, from_path: Option<&str>) -> Option<String> {
        let target = match self.lookup(name, from_path) {
            Some(def) => Target::Def(def),
            None => self.member_by_name(name, from_path)?,
        };
        let page = self.page(target)?;
        Some(self.page_markdown(&page, matches!(target, Target::Def(_))))
    }

    /// What `target` shows, or `None` if it is undocumented.
    pub(crate) fn page<'a>(&'a self, target: Target<'a>) -> Option<Page<'a>> {
        match target {
            Target::Def(def) if def.def().kind == DefKind::Function => {
                let doc = self.resolve(def)?;
                Some(Page {
                    name: def.def().name.clone(),
                    path: def.path,
                    formals: def.formals().to_vec(),
                    usage: None,
                    doc,
                    callable: true,
                    def: Some(def),
                })
            }
            Target::Def(def) => self.oo_page(def),
            Target::New(class) => self.object_page(class, true),
            Target::Member {
                class,
                owner,
                member,
            } => self.member_page(class, owner, member),
        }
    }

    fn page_markdown(&self, page: &Page<'_>, note_duplicates: bool) -> String {
        let markdown =
            markdown::help_page(&page.name, file_label(page.path), &page.usage(), &page.doc);
        match page.def {
            Some(def) if note_duplicates => self.with_duplicate_note(def, markdown),
            _ => markdown,
        }
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

    /// Every documented definition in the workspace, ordered by path and position.
    pub fn documented_functions(&self) -> Vec<FunctionSummary> {
        let mut paths: Vec<&String> = self.files.keys().collect();
        paths.sort();
        let mut out = Vec::new();
        for path in paths {
            let file = &self.files[path];
            for idx in 0..file.defs.len() {
                let def = DefRef { path, file, idx };
                let title = if def.def().kind == DefKind::Function {
                    self.summary_title(def)
                } else {
                    self.oo_page(def).map(|page| page.doc.title)
                };
                if let Some(title) = title {
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

    /// Every S4 or S7 method registered for `generic`, ordered by path and position.
    pub(crate) fn methods_of(
        &self,
        generic: &str,
    ) -> impl Iterator<Item = (&FileEntry, &MethodDef)> {
        self.by_generic
            .get(generic)
            .into_iter()
            .flatten()
            .filter_map(|(path, idx)| {
                let file = self.files.get(path)?;
                Some((file, file.methods.get(*idx)?))
            })
    }
}

pub(crate) fn file_label(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}
