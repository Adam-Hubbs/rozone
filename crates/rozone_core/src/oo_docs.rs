//! Documentation for S4, R6 and S7 classes and generics, and for R6 members
//! reached through `x$name`.

use std::collections::HashMap;

use air_r_syntax::{RFunctionDefinition, RSyntaxKind, RSyntaxNode};
use biome_rowan::{AstNode, TextSize};

use crate::DocSource;
use crate::call::Receiver;
use crate::extract::{DefKind, Formal, Member, MemberKind, formals, unquote};
use crate::index::{DefRef, FileEntry, Index, Page, Target};
use crate::markdown;
use crate::resolve::Resolved;
use crate::roxygen::Block;

/// Inheritance chains longer than this are cut, which also stops cycles.
const MAX_CHAIN: usize = 16;
const MAX_METHODS: usize = 20;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Public,
    Private,
    Any,
}

impl Access {
    fn allows(self, member: &Member) -> bool {
        match self {
            Self::Public => !member.private,
            Self::Private => member.private,
            Self::Any => true,
        }
    }
}

impl Index {
    /// The page for a class or generic definition.
    pub(crate) fn oo_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        match def.def().kind {
            DefKind::S4Generic | DefKind::S7Generic => self.generic_page(def),
            DefKind::S4Class | DefKind::S7Class => self.class_page(def),
            DefKind::R6Class => self.r6_page(def, false),
            DefKind::Function => None,
        }
    }

    /// A generic's own documentation plus the methods registered for it in
    /// the workspace. Documented methods make an undocumented generic worth
    /// showing.
    fn generic_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        let name = &def.def().name;
        let methods: Vec<(String, Option<String>)> = self
            .methods_of(name)
            .map(|(file, method)| {
                let summary = method.block(&file.text).and_then(Block::summary_line);
                (format!("{name}(<{}>)", method.classes.join(", ")), summary)
            })
            .collect();
        let own = self.resolve_fields(def, true);
        if own.is_none() && methods.iter().all(|(_, summary)| summary.is_none()) {
            return None;
        }
        let mut doc = own.unwrap_or_else(|| Resolved::empty(DocSource::Static));
        if !methods.is_empty() {
            doc.sections
                .push(("Methods".to_string(), list(&methods, MAX_METHODS)));
        }
        Some(Page {
            name: name.clone(),
            path: def.path,
            formals: def.formals().to_vec(),
            usage: None,
            doc,
            callable: true,
            def: Some(def),
        })
    }

    /// An S4 or S7 class: its constructor's arguments are its slots or
    /// properties, inherited ones included, unless an S7 class has its own
    /// `constructor`.
    fn class_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        let definition = def.def();
        let class = definition.class.as_ref()?;
        let mut doc = self.resolve_fields(def, class.custom_constructor)?;
        let formals = self.class_formals(def);
        if class.custom_constructor {
            let block = def.block();
            let props: Vec<(String, Option<String>)> = class
                .members
                .iter()
                .map(|m| {
                    let text = block.and_then(|b| b.prop(&m.name)).map(str::to_string);
                    (m.name.clone(), text)
                })
                .collect();
            if !props.is_empty() {
                doc.sections
                    .push(("Properties".to_string(), list(&props, usize::MAX)));
            }
        } else {
            let documented = self.class_param_docs(def, &formals);
            doc.params = formals
                .iter()
                .filter_map(|f| Some((f.name.clone(), documented.get(&f.name)?.clone())))
                .collect();
        }
        doc.related.extend(inherits_line(definition.parent()));
        let usage = (!class.callable).then(|| {
            let mut args = vec![Formal {
                name: format!("\"{}\"", definition.name),
                default: None,
            }];
            args.extend(formals.iter().cloned());
            markdown::signature("new", &args).label
        });
        Some(Page {
            name: definition.name.clone(),
            path: def.path,
            formals,
            usage,
            doc,
            callable: class.callable,
            def: Some(def),
        })
    }

    /// An R6 class, shown with the usage of `$new()`. `constructor` is the
    /// page for `Class$new` itself, which is callable.
    pub(crate) fn r6_page<'a>(&'a self, class: DefRef<'a>, constructor: bool) -> Option<Page<'a>> {
        let definition = class.def();
        let text = &class.file.text;
        let block = class.block();
        let own = self.resolve_fields(class, false);
        let public: Vec<&Member> = definition.members().iter().filter(|m| !m.private).collect();
        let member_documented = public
            .iter()
            .any(|m| m.block(text).is_some_and(Block::has_content));
        let documented_fields = block.is_some_and(|b| !b.fields.is_empty());
        if own.is_none() && !member_documented && !documented_fields {
            return None;
        }
        let mut doc = own.unwrap_or_else(|| Resolved::empty(DocSource::Static));

        let initialize = self.find_member(class, "initialize", Access::Any);
        let formals = initialize
            .map(|(_, m)| m.formals().to_vec())
            .unwrap_or_default();
        if let Some((owner, member)) = initialize
            && let Some(init_block) = member.block(&owner.file.text)
        {
            doc.params = formals
                .iter()
                .filter_map(|f| Some((f.name.clone(), init_block.param(&f.name)?.to_string())))
                .collect();
        }

        let field_doc = |member: &Member| {
            block
                .and_then(|b| b.field(&member.name))
                .map(str::to_string)
                .or_else(|| {
                    let own = member.block(text)?;
                    own.field(&member.name)
                        .map(str::to_string)
                        .or_else(|| own.summary_line())
                })
        };
        for (title, kind) in [
            ("Fields", MemberKind::Field),
            ("Active bindings", MemberKind::Active),
        ] {
            let entries: Vec<(String, Option<String>)> = public
                .iter()
                .filter(|m| m.kind == kind)
                .map(|m| (m.name.clone(), field_doc(m)))
                .collect();
            if !entries.is_empty() {
                doc.sections
                    .push((title.to_string(), list(&entries, usize::MAX)));
            }
        }
        let methods: Vec<(String, Option<String>)> = public
            .iter()
            .filter(|m| m.kind == MemberKind::Method)
            .map(|m| {
                let shown = if m.name == "initialize" {
                    "new"
                } else {
                    &m.name
                };
                (
                    format!("${shown}()"),
                    m.block(text).and_then(Block::summary_line),
                )
            })
            .collect();
        if !methods.is_empty() {
            doc.sections
                .push(("Methods".to_string(), list(&methods, usize::MAX)));
        }
        doc.related.extend(inherits_line(definition.parent()));

        let new_name = format!("{}$new", definition.name);
        Some(Page {
            usage: Some(markdown::signature(&new_name, &formals).label),
            name: if constructor {
                new_name
            } else {
                definition.name.clone()
            },
            path: class.path,
            formals,
            doc,
            callable: constructor,
            def: Some(class),
        })
    }

    /// An R6 method, field or active binding.
    pub(crate) fn member_page<'a>(
        &'a self,
        class: DefRef<'a>,
        owner: DefRef<'a>,
        member: &'a Member,
    ) -> Option<Page<'a>> {
        let name = format!("{}${}", class.def().name, member.name);
        let own_block = member.block(&owner.file.text);
        let relation = if owner.key() == class.key() {
            format!("*Member of `{}`.*", class.def().name)
        } else {
            format!("*Inherited from `{}`.*", owner.def().name)
        };
        match member.kind {
            MemberKind::Method => {
                let block = own_block.filter(|b| b.has_content())?;
                let mut doc = block_doc(block);
                doc.params = member
                    .formals()
                    .iter()
                    .filter_map(|f| Some((f.name.clone(), block.param(&f.name)?.to_string())))
                    .collect();
                doc.related.push(relation);
                Some(Page {
                    name,
                    path: owner.path,
                    formals: member.formals().to_vec(),
                    usage: None,
                    doc,
                    callable: true,
                    def: None,
                })
            }
            MemberKind::Field | MemberKind::Active => {
                let text = owner
                    .block()
                    .and_then(|b| b.field(&member.name))
                    .map(str::to_string)
                    .or_else(|| {
                        let own = own_block?;
                        own.field(&member.name)
                            .map(str::to_string)
                            .or_else(|| own.description.clone())
                            .or_else(|| own.title.clone())
                    })?;
                let mut doc = Resolved::empty(DocSource::Static);
                doc.description = Some(text);
                doc.related.push(relation);
                Some(Page {
                    usage: Some(name.clone()),
                    name,
                    path: owner.path,
                    formals: Vec::new(),
                    doc,
                    callable: false,
                    def: None,
                })
            }
            MemberKind::Slot | MemberKind::Property => None,
        }
    }

    /// What `receiver$name` refers to: `Class$new`, a member of the enclosing
    /// class through `self`, `private` or `super`, or a member of the class an
    /// identifier was last assigned from with `Class$new()` in scope.
    pub(crate) fn member_target<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        name: &str,
        receiver: &Receiver,
    ) -> Option<Target<'a>> {
        let at = receiver.node.text_trimmed_range().start();
        let (class, access) = match receiver.name.as_str() {
            "self" => (self.enclosing_r6(path, file, at)?, Access::Public),
            "private" => (self.enclosing_r6(path, file, at)?, Access::Private),
            "super" => (
                self.parent_of(self.enclosing_r6(path, file, at)?)?,
                Access::Any,
            ),
            other => {
                if let Some(class) = self
                    .lookup(other, Some(path))
                    .filter(|d| d.def().kind == DefKind::R6Class)
                {
                    return (name == "new").then_some(Target::New(class));
                }
                let class_name = assigned_class(&receiver.node, other)?;
                let class = self
                    .lookup(&class_name, Some(path))
                    .filter(|d| d.def().kind == DefKind::R6Class)?;
                (class, Access::Public)
            }
        };
        let (owner, member) = self.find_member(class, name, access)?;
        Some(Target::Member {
            class,
            owner,
            member,
        })
    }

    /// `Class$member` by name, public members first.
    pub(crate) fn member_by_name<'a>(
        &'a self,
        class: &str,
        member: &str,
        from_path: Option<&str>,
    ) -> Option<Target<'a>> {
        let class = self
            .lookup(class, from_path)
            .filter(|d| d.def().kind == DefKind::R6Class)?;
        if member == "new" {
            return Some(Target::New(class));
        }
        let (owner, member) = self
            .find_member(class, member, Access::Public)
            .or_else(|| self.find_member(class, member, Access::Any))?;
        Some(Target::Member {
            class,
            owner,
            member,
        })
    }

    fn enclosing_r6<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        at: TextSize,
    ) -> Option<DefRef<'a>> {
        let idx = file
            .defs
            .iter()
            .position(|d| d.kind == DefKind::R6Class && d.stmt_range.contains(at))?;
        Some(DefRef { path, file, idx })
    }

    /// The class `def` inherits from, when it is defined in the workspace.
    fn parent_of<'a>(&'a self, def: DefRef<'a>) -> Option<DefRef<'a>> {
        let parent = def.def().parent()?;
        self.lookup(parent, Some(def.path))
            .filter(|p| p.def().kind == def.def().kind && p.key() != def.key())
    }

    /// `def`, then its ancestors.
    fn chain<'a>(&'a self, def: DefRef<'a>) -> Vec<DefRef<'a>> {
        let mut chain = vec![def];
        let mut current = def;
        while chain.len() < MAX_CHAIN {
            match self.parent_of(current) {
                Some(parent) if !chain.iter().any(|c| c.key() == parent.key()) => {
                    chain.push(parent);
                    current = parent;
                }
                _ => break,
            }
        }
        chain
    }

    fn find_member<'a>(
        &'a self,
        class: DefRef<'a>,
        name: &str,
        access: Access,
    ) -> Option<(DefRef<'a>, &'a Member)> {
        self.chain(class).into_iter().find_map(|owner| {
            let member = owner
                .def()
                .members()
                .iter()
                .find(|m| m.name == name && access.allows(m))?;
            Some((owner, member))
        })
    }

    /// The constructor's arguments. S4 and S7 classes take their ancestors'
    /// slots or properties before their own; an S7 class below one with a
    /// custom constructor takes `...` for everything above it.
    fn class_formals(&self, def: DefRef<'_>) -> Vec<Formal> {
        let definition = def.def();
        let custom = |d: &DefRef<'_>| d.def().class.as_ref().is_some_and(|c| c.custom_constructor);
        if definition.kind == DefKind::S7Class && custom(&def) {
            return definition.formals().to_vec();
        }
        let mut chain = self.chain(def);
        let mut out: Vec<Formal> = Vec::new();
        if definition.kind == DefKind::S7Class
            && let Some(pos) = chain.iter().skip(1).position(custom)
        {
            chain.truncate(pos + 1);
            out.push(Formal {
                name: "...".to_string(),
                default: None,
            });
        }
        for class in chain.iter().rev() {
            for formal in class.def().formals() {
                match out.iter_mut().find(|f| f.name == formal.name) {
                    Some(existing) => {
                        if formal.default.is_some() {
                            existing.default = formal.default.clone();
                        }
                    }
                    None => out.push(formal.clone()),
                }
            }
        }
        out
    }

    /// Constructor argument docs: `@param`, then `@slot` (S4) or `@prop`
    /// (S7), from the class and then its ancestors, so a subclass can
    /// redocument an inherited argument.
    fn class_param_docs(&self, def: DefRef<'_>, formals: &[Formal]) -> HashMap<String, String> {
        let kind = def.def().kind;
        let mut documented: HashMap<String, String> = HashMap::new();
        for class in self.chain(def) {
            let Some(block) = class.block() else { continue };
            for formal in formals {
                let text = block.param(&formal.name).or_else(|| match kind {
                    DefKind::S4Class => block.slot(&formal.name),
                    _ => block.prop(&formal.name),
                });
                if let Some(text) = text {
                    documented
                        .entry(formal.name.clone())
                        .or_insert_with(|| text.to_string());
                }
            }
        }
        documented
    }
}

/// A method's or member's own block as documentation.
fn block_doc(block: &Block) -> Resolved {
    let mut doc = Resolved::empty(DocSource::Static);
    doc.title = block.title.clone();
    doc.description = block.description.clone();
    doc.details = block.details.clone();
    doc.returns = block.returns.clone();
    doc.examples = block.examples.clone();
    doc.seealso = block.seealso.clone();
    doc.sections = block
        .sections
        .iter()
        .map(|s| (s.title.clone(), s.text.clone()))
        .collect();
    doc
}

fn inherits_line(parent: Option<&str>) -> Option<String> {
    let parent = parent?;
    let base = parent == "S7_object" || parent.starts_with("class_");
    (!base).then(|| format!("*Inherits from `{parent}`.*"))
}

/// A markdown list of `` `name`: summary `` lines.
fn list(entries: &[(String, Option<String>)], max: usize) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .take(max)
        .map(|(name, summary)| match summary {
            Some(text) => format!("- `{name}`: {text}"),
            None => format!("- `{name}`"),
        })
        .collect();
    if entries.len() > max {
        lines.push(format!("- and {} more", entries.len() - max));
    }
    lines.join("\n")
}

/// The class `name` was last assigned from with `Class$new(...)` before
/// `node`, in the innermost enclosing scope that assigns it. A function
/// parameter of that name hides outer assignments, so it gives `None`.
fn assigned_class(node: &RSyntaxNode, name: &str) -> Option<String> {
    let at = node.text_trimmed_range().start();
    for scope in node.ancestors() {
        match scope.kind() {
            RSyntaxKind::R_STATEMENT_LIST => {
                let mut found = None;
                for stmt in scope.children() {
                    if stmt.text_trimmed_range().end() > at {
                        break;
                    }
                    if let Some(class) = assignment_to(&stmt, name) {
                        found = Some(class);
                    }
                }
                if let Some(class) = found {
                    return class;
                }
            }
            RSyntaxKind::R_FUNCTION_DEFINITION => {
                let function = RFunctionDefinition::cast(scope)?;
                if formals(&function).iter().any(|f| f.name == name) {
                    return None;
                }
            }
            _ => {}
        }
    }
    None
}

/// For a statement assigning to `name`: `Some(Some(class))` for
/// `name <- Class$new(...)`, `Some(None)` for any other value.
fn assignment_to(stmt: &RSyntaxNode, name: &str) -> Option<Option<String>> {
    let binary = stmt
        .first_child()
        .filter(|n| n.kind() == RSyntaxKind::R_BINARY_EXPRESSION)?;
    let mut children = binary.children_with_tokens();
    let left = children.next()?.into_node()?;
    let op = children.next()?.into_token()?;
    if !matches!(
        op.kind(),
        RSyntaxKind::ASSIGN | RSyntaxKind::EQUAL | RSyntaxKind::SUPER_ASSIGN
    ) || left.kind() != RSyntaxKind::R_IDENTIFIER
        || unquote(&left.text_trimmed().to_string()) != name
    {
        return None;
    }
    let value = binary.last_child()?;
    Some(new_call_class(&value))
}

/// `Class` in `Class$new(...)`.
fn new_call_class(value: &RSyntaxNode) -> Option<String> {
    if value.kind() != RSyntaxKind::R_CALL {
        return None;
    }
    let extract = value
        .first_child()
        .filter(|n| n.kind() == RSyntaxKind::R_EXTRACT_EXPRESSION)?;
    let class = extract
        .first_child()
        .filter(|n| n.kind() == RSyntaxKind::R_IDENTIFIER)?;
    let member = extract
        .last_child()
        .filter(|n| n.kind() == RSyntaxKind::R_IDENTIFIER)?;
    (member.text_trimmed() == "new").then(|| unquote(&class.text_trimmed().to_string()))
}
