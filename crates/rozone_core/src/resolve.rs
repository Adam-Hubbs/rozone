//! Turns a definition's roxygen block into the documentation to show:
//! shared pages (`@rdname`, `@describeIn`), inheritance, and the manifest
//! overlay.

use std::collections::HashMap;

use crate::DocSource;
use crate::extract::Definition;
use crate::index::{DefKey, DefRef, Index};
use crate::manifest::Topic;
use crate::roxygen::Block;

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub title: Option<String>,
    pub description: Option<String>,
    pub details: Option<String>,
    /// Documented formals, in formal order.
    pub params: Vec<(String, String)>,
    pub returns: Option<String>,
    pub sections: Vec<(String, String)>,
    pub examples: Option<String>,
    pub example_files: Vec<String>,
    pub seealso: Option<String>,
    pub family: Option<String>,
    /// How this function relates to other pages, as markdown lines.
    pub related: Vec<String>,
    /// Pointers for what could not be resolved, as plain sentences.
    pub notes: Vec<String>,
    pub inherited_from: Vec<String>,
    pub source: DocSource,
}

impl Resolved {
    fn empty(source: DocSource) -> Self {
        Self {
            title: None,
            description: None,
            details: None,
            params: Vec::new(),
            returns: None,
            sections: Vec::new(),
            examples: None,
            example_files: Vec::new(),
            seealso: None,
            family: None,
            related: Vec::new(),
            notes: Vec::new(),
            inherited_from: Vec::new(),
            source,
        }
    }

    fn from_topic(topic: &Topic, def: &Definition) -> Self {
        let present = |text: &Option<String>| text.clone().filter(|t| !t.trim().is_empty());
        let mut resolved = Self::empty(DocSource::Manifest);
        resolved.title = present(&topic.title);
        resolved.description = present(&topic.description_md);
        resolved.details = present(&topic.details_md);
        resolved.returns = present(&topic.returns_md);
        resolved.examples = present(&topic.examples);
        resolved.sections = topic
            .sections
            .iter()
            .map(|s| (s.title.clone(), s.md.clone()))
            .collect();
        resolved.inherited_from = topic.inherited_from.clone();
        resolved.params = def
            .formals()
            .iter()
            .filter_map(|formal| {
                let param = topic
                    .params
                    .iter()
                    .find(|p| p.name == formal.name && !p.md.trim().is_empty())?;
                Some((formal.name.clone(), param.md.clone()))
            })
            .collect();
        resolved
    }
}

/// Definitions currently being expanded, to stop inheritance cycles.
#[derive(Default)]
struct Walk<'a> {
    fields: Vec<DefKey<'a>>,
    params: Vec<DefKey<'a>>,
}

const MAX_RELATED: usize = 6;

impl Index {
    /// The documentation for `def`, or `None` if it has none.
    pub(crate) fn resolve<'a>(&'a self, def: DefRef<'a>) -> Option<Resolved> {
        let definition = def.def();
        if let Some(topic) = self
            .manifest()
            .and_then(|m| m.topic_for(def.path, def.file.hash(), &definition.name))
        {
            return Some(Resolved::from_topic(topic, definition));
        }
        let block = def.block().filter(|b| b.has_content())?;
        Some(self.resolve_static(def, block, &mut Walk::default(), true))
    }

    /// `None` if undocumented, otherwise the title if there is one. Avoids a
    /// full resolution where the block already has its title.
    pub(crate) fn summary_title<'a>(&'a self, def: DefRef<'a>) -> Option<Option<String>> {
        let definition = def.def();
        if let Some(topic) = self
            .manifest()
            .and_then(|m| m.topic_for(def.path, def.file.hash(), &definition.name))
        {
            return Some(topic.title.clone().filter(|t| !t.trim().is_empty()));
        }
        let block = def.block().filter(|b| b.has_content())?;
        let direct = block.title.clone().or_else(|| {
            block
                .describe_in
                .as_ref()
                .map(|d| d.description.clone())
                .filter(|d| !d.is_empty())
        });
        if direct.is_some() || (block.inherit.is_empty() && block.rdname.is_none()) {
            return Some(direct);
        }
        Some(
            self.resolve_static(def, block, &mut Walk::default(), false)
                .title,
        )
    }

    fn resolve_static<'a>(
        &'a self,
        def: DefRef<'a>,
        block: &'a Block,
        walk: &mut Walk<'a>,
        with_params: bool,
    ) -> Resolved {
        let mut resolved = Resolved::empty(DocSource::Static);
        let key = def.key();
        if walk.fields.contains(&key) {
            return resolved;
        }
        walk.fields.push(key);

        let (members, field_peers) = self.peers(def);
        let blocks: Vec<&Block> = std::iter::once(block)
            .chain(field_peers.iter().filter_map(|peer| peer.block()))
            .collect();
        let pick =
            |field: fn(&Block) -> Option<&String>| blocks.iter().find_map(|b| field(b)).cloned();

        resolved.title = pick(|b| b.title.as_ref()).or_else(|| {
            block
                .describe_in
                .as_ref()
                .map(|d| d.description.clone())
                .filter(|d| !d.is_empty())
        });
        resolved.description = pick(|b| b.description.as_ref());
        resolved.details = pick(|b| b.details.as_ref());
        resolved.returns = pick(|b| b.returns.as_ref());
        resolved.examples = pick(|b| b.examples.as_ref());
        resolved.seealso = pick(|b| b.seealso.as_ref());
        resolved.family = pick(|b| b.family.as_ref());
        resolved.example_files = blocks
            .iter()
            .find(|b| !b.example_files.is_empty())
            .map(|b| b.example_files.clone())
            .unwrap_or_default();
        for section in blocks.iter().flat_map(|b| &b.sections) {
            if !resolved
                .sections
                .iter()
                .any(|(title, _)| *title == section.title)
            {
                resolved
                    .sections
                    .push((section.title.clone(), section.text.clone()));
            }
        }

        for inherit in &block.inherit {
            self.apply_inherit(def, &inherit.source, &inherit.fields, &mut resolved, walk);
        }
        for source in &block.inherit_sections {
            resolved
                .notes
                .push(format!("Also inherits sections from `{source}`."));
        }

        if with_params {
            let documented = self.params_of(def, walk);
            resolved.params = def
                .formals()
                .iter()
                .filter_map(|formal| {
                    Some((formal.name.clone(), documented.get(&formal.name)?.clone()))
                })
                .collect();
        }

        resolved.related = self.related_lines(def, block, &members);
        walk.fields.pop();
        resolved
    }

    fn apply_inherit<'a>(
        &'a self,
        def: DefRef<'a>,
        source: &str,
        fields: &[String],
        resolved: &mut Resolved,
        walk: &mut Walk<'a>,
    ) {
        let wants = |names: &[&str]| {
            fields.is_empty() || fields.iter().any(|f| names.contains(&f.as_str()))
        };
        let Some(src_def) = self.source_def(source, def.path) else {
            if fields.is_empty()
                || fields
                    .iter()
                    .any(|f| !matches!(f.as_str(), "params" | "param"))
            {
                resolved.inherited_from.push(source.to_string());
                resolved
                    .notes
                    .push(format!("Inherits documentation from `{source}`."));
            }
            return;
        };
        let Some(src_block) = src_def.block() else {
            return;
        };
        let src = self.resolve_static(src_def, src_block, walk, false);
        let fill = |target: &mut Option<String>, from: Option<String>, names: &[&str]| {
            if target.is_none() && wants(names) {
                *target = from;
            }
        };
        fill(&mut resolved.title, src.title, &["title"]);
        fill(&mut resolved.description, src.description, &["description"]);
        fill(&mut resolved.details, src.details, &["details"]);
        fill(&mut resolved.returns, src.returns, &["return", "returns"]);
        fill(&mut resolved.seealso, src.seealso, &["seealso"]);
        fill(&mut resolved.examples, src.examples, &["examples"]);
        if wants(&["sections"]) {
            for section in src.sections {
                if !resolved
                    .sections
                    .iter()
                    .any(|(title, _)| *title == section.0)
                {
                    resolved.sections.push(section);
                }
            }
        }
    }

    /// Documentation for every name that `def`'s page documents: its own
    /// `@param`s, those of the blocks sharing its page, then whatever the
    /// inheritance tags provide for formals still undocumented.
    fn params_of<'a>(&'a self, def: DefRef<'a>, walk: &mut Walk<'a>) -> HashMap<String, String> {
        let key = def.key();
        if walk.params.contains(&key) {
            return HashMap::new();
        }
        walk.params.push(key);
        let documented = self.collect_params(def, walk);
        walk.params.pop();
        documented
    }

    fn collect_params<'a>(
        &'a self,
        def: DefRef<'a>,
        walk: &mut Walk<'a>,
    ) -> HashMap<String, String> {
        let (members, _) = self.peers(def);
        let blocks: Vec<&Block> = def
            .block()
            .into_iter()
            .chain(members.iter().filter_map(|peer| peer.block()))
            .collect();
        let mut documented: HashMap<String, String> = HashMap::new();
        for param in blocks.iter().flat_map(|b| &b.params) {
            for name in &param.names {
                documented
                    .entry(name.clone())
                    .or_insert_with(|| param.text.clone());
            }
        }

        let formals = def.formals();
        let missing = |documented: &HashMap<String, String>| {
            formals.iter().any(|f| !documented.contains_key(&f.name))
        };
        let mut pointers: Vec<&str> = Vec::new();
        let sources = blocks.iter().flat_map(|b| {
            let from_inherit = b
                .inherit
                .iter()
                .filter(|i| {
                    i.fields.is_empty()
                        || i.fields
                            .iter()
                            .any(|f| matches!(f.as_str(), "params" | "param"))
                })
                .map(|i| i.source.as_str());
            b.inherit_params
                .iter()
                .map(String::as_str)
                .chain(from_inherit)
        });
        for source in sources {
            if !missing(&documented) {
                break;
            }
            match self.source_def(source, def.path) {
                Some(src_def) => {
                    let inherited = self.params_of(src_def, walk);
                    for formal in formals {
                        if let Some(text) = inherited.get(&formal.name) {
                            documented
                                .entry(formal.name.clone())
                                .or_insert_with(|| text.clone());
                        }
                    }
                }
                None => pointers.push(source),
            }
        }
        for source in blocks.iter().flat_map(|b| &b.inherit_dots) {
            documented
                .entry("...".to_string())
                .or_insert_with(|| format!("Arguments passed on to `{source}`."));
        }
        if !pointers.is_empty() {
            let from = pointers
                .iter()
                .map(|p| format!("`{p}`"))
                .collect::<Vec<_>>()
                .join(" or ");
            for formal in formals {
                documented
                    .entry(formal.name.clone())
                    .or_insert_with(|| format!("Inherited from {from}."));
            }
        }
        documented
    }

    /// A workspace-local inheritance source; `pkg::fn` and unknown names are
    /// pointers only.
    fn source_def<'a>(&'a self, source: &str, from_path: &str) -> Option<DefRef<'a>> {
        if source.contains("::") {
            return None;
        }
        self.lookup(source, Some(from_path))
    }

    /// The help page `def` belongs to: its `@rdname`, else its `@describeIn`
    /// parent's page, else its own name.
    fn page_of(&self, def: DefRef<'_>, depth: u8) -> String {
        let definition = def.def();
        let Some(block) = def.block() else {
            return definition.name.clone();
        };
        if let Some(rdname) = &block.rdname {
            return rdname.clone();
        }
        if let Some(describe) = &block.describe_in {
            if depth < 8
                && let Some(parent) = self
                    .lookup(&describe.parent, Some(def.path))
                    .filter(|p| p.key() != def.key())
            {
                return self.page_of(parent, depth + 1);
            }
            return describe.parent.clone();
        }
        definition.name.clone()
    }

    /// Other definitions on `def`'s page: all of them (for parameters), and
    /// those that contribute whole fields (everything but `@describeIn` ones,
    /// and nothing at all if `def` is itself a `@describeIn`).
    fn peers<'a>(&'a self, def: DefRef<'a>) -> (Vec<DefRef<'a>>, Vec<DefRef<'a>>) {
        let page = self.page_of(def, 0);
        let mut members = self.page_members(&page, def.path);
        members.retain(|m| m.key() != def.key());
        let is_describe = def.block().is_some_and(|b| b.describe_in.is_some());
        let field_peers = if is_describe {
            Vec::new()
        } else {
            members
                .iter()
                .copied()
                .filter(|m| m.block().is_some_and(|b| b.describe_in.is_none()))
                .collect()
        };
        (members, field_peers)
    }

    /// The primary definition (named like the page) first, then by position.
    fn page_members<'a>(&'a self, page: &str, origin: &str) -> Vec<DefRef<'a>> {
        let mut members: Vec<DefRef<'a>> = Vec::new();
        let mut parents = vec![page.to_string()];
        for _ in 0..3 {
            let before = members.len();
            // Same-named definitions elsewhere are separate functions, so a
            // name only contributes the definition it resolves to from `origin`.
            let mut candidates: Vec<DefRef<'a>> = parents
                .iter()
                .filter_map(|parent| self.lookup(parent, Some(origin)))
                .collect();
            for (path, file) in self.files() {
                let maps = file.maps();
                candidates.extend(
                    maps.by_rdname
                        .get(page)
                        .into_iter()
                        .flatten()
                        .map(|&idx| DefRef { path, file, idx }),
                );
                for parent in &parents {
                    candidates.extend(
                        maps.by_describe
                            .get(parent.as_str())
                            .into_iter()
                            .flatten()
                            .map(|&idx| DefRef { path, file, idx }),
                    );
                }
            }
            for candidate in candidates {
                if !members.iter().any(|m| m.key() == candidate.key())
                    && self.page_of(candidate, 0) == page
                {
                    members.push(candidate);
                }
            }
            if members.len() == before {
                break;
            }
            parents = members.iter().map(|m| m.def().name.clone()).collect();
        }
        members.sort_by(|a, b| {
            let primary = |m: &DefRef<'_>| m.def().name != page;
            (primary(a), a.path, a.def().name_range.start()).cmp(&(
                primary(b),
                b.path,
                b.def().name_range.start(),
            ))
        });
        members
    }

    fn related_lines(&self, def: DefRef<'_>, block: &Block, members: &[DefRef<'_>]) -> Vec<String> {
        if let Some(describe) = &block.describe_in {
            return vec![format!(
                "*Part of the documentation of `{}()`.*",
                describe.parent
            )];
        }
        let mut names: Vec<&str> = members
            .iter()
            .map(|m| m.def().name.as_str())
            .filter(|n| *n != def.def().name)
            .collect();
        names.dedup();
        if names.is_empty() {
            return Vec::new();
        }
        let more = names.len().saturating_sub(MAX_RELATED);
        let listed = names
            .iter()
            .take(MAX_RELATED)
            .map(|n| format!("`{n}()`"))
            .collect::<Vec<_>>()
            .join(", ");
        let tail = if more > 0 {
            format!(" and {more} more")
        } else {
            String::new()
        };
        vec![format!("*Shares its help page with {listed}{tail}.*")]
    }
}
