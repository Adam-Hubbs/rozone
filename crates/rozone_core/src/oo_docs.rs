//! Documentation for S4, R6, reference class and S7 definitions, and for the
//! members reached through `x$name` and the slots through `x@name`.

use std::collections::HashMap;

use air_r_syntax::{RFunctionDefinition, RSyntaxKind, RSyntaxNode};
use biome_rowan::{AstNode, TextSize};

use crate::DocSource;
use crate::call::Receiver;
use crate::extract::{DefKind, Formal, Member, MemberKind, formals, unquote};
use crate::index::{DefRef, FileEntry, Index, Page, Target};
use crate::markdown;
use crate::oo::dispatch_class;
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
    /// The page for a class, union or generic definition.
    pub(crate) fn oo_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        match def.def().kind {
            DefKind::S4Generic | DefKind::S7Generic | DefKind::S7ExternalGeneric => {
                self.generic_page(def)
            }
            DefKind::S4Class | DefKind::S7Class => self.class_page(def),
            DefKind::R6Class | DefKind::RefClass => self.object_page(def, false),
            DefKind::S7Union => self.union_page(def),
            DefKind::Function => None,
        }
    }

    /// A generic's own documentation plus the methods registered for it in
    /// the workspace. Documented methods make an undocumented generic worth
    /// showing. An external generic is shown with the generic it stands for.
    fn generic_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        let definition = def.def();
        let name = &definition.name;
        let shown = definition.external.as_deref().unwrap_or(name);
        let methods: Vec<(String, Option<String>)> = self
            .methods_of(name)
            .map(|(file, method)| {
                let summary = method.block(&file.text).and_then(Block::summary_line);
                (format!("{shown}(<{}>)", method.classes.join(", ")), summary)
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
        let usage = definition.external.as_ref().map(|external| {
            doc.related
                .push(format!("*Registers methods for `{external}`.*"));
            markdown::signature(external, definition.formals()).label
        });
        Some(Page {
            name: name.clone(),
            path: def.path,
            formals: definition.formals().to_vec(),
            callable: usage.is_none(),
            usage,
            doc,
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
        Some(Page {
            name: definition.name.clone(),
            path: def.path,
            usage: (!class.callable).then(|| new_usage(&definition.name, &formals)),
            formals,
            doc,
            callable: class.callable,
            def: Some(def),
        })
    }

    /// An R6 or reference class: its fields, active bindings and methods, and
    /// its constructor. `constructor` is the page for `Class$new` itself.
    pub(crate) fn object_page<'a>(
        &'a self,
        class: DefRef<'a>,
        constructor: bool,
    ) -> Option<Page<'a>> {
        let definition = class.def();
        let info = definition.class.as_ref()?;
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

        let formals = self.class_formals(class);
        doc.params = match self.find_member(class, "initialize", Access::Any) {
            Some((owner, member)) => member
                .block(&owner.file.text)
                .map(|init| {
                    formals
                        .iter()
                        .filter_map(|f| Some((f.name.clone(), init.param(&f.name)?.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            // A reference class's default constructor takes its fields.
            None => {
                let documented = self.class_param_docs(class, &formals);
                formals
                    .iter()
                    .filter_map(|f| Some((f.name.clone(), documented.get(&f.name)?.clone())))
                    .collect()
            }
        };

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
        let generator = definition.kind == DefKind::RefClass && info.callable;
        let usage = if constructor || definition.kind == DefKind::R6Class {
            markdown::signature(&new_name, &formals).label
        } else if generator {
            markdown::signature(&definition.name, &formals).label
        } else {
            new_usage(&definition.name, &formals)
        };
        Some(Page {
            usage: Some(usage),
            name: if constructor {
                new_name
            } else {
                definition.name.clone()
            },
            path: class.path,
            formals,
            doc,
            callable: constructor || generator,
            def: Some(class),
        })
    }

    /// An S7 union: a type made of other classes.
    fn union_page<'a>(&'a self, def: DefRef<'a>) -> Option<Page<'a>> {
        let definition = def.def();
        let classes = &definition.class.as_ref()?.union_of;
        let mut doc = self.resolve_fields(def, false)?;
        let entries: Vec<(String, Option<String>)> =
            classes.iter().map(|c| (c.clone(), None)).collect();
        doc.sections
            .push(("Classes".to_string(), list(&entries, usize::MAX)));
        Some(Page {
            name: definition.name.clone(),
            path: def.path,
            formals: Vec::new(),
            usage: Some(format!("new_union({})", classes.join(", "))),
            doc,
            callable: false,
            def: Some(def),
        })
    }

    /// An R6 or reference class method or field, or an S4 slot or S7
    /// property.
    pub(crate) fn member_page<'a>(
        &'a self,
        class: DefRef<'a>,
        owner: DefRef<'a>,
        member: &'a Member,
    ) -> Option<Page<'a>> {
        let slot = matches!(member.kind, MemberKind::Slot | MemberKind::Property);
        let name = format!(
            "{}{}{}",
            class.def().name,
            if slot { "@" } else { "$" },
            member.name
        );
        let own_block = member.block(&owner.file.text);
        let relation = if owner.key() != class.key() {
            format!("*Inherited from `{}`.*", owner.def().name)
        } else {
            let what = match member.kind {
                MemberKind::Slot => "Slot",
                MemberKind::Property => "Property",
                _ => "Member",
            };
            format!("*{what} of `{}`.*", class.def().name)
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
            MemberKind::Field | MemberKind::Active | MemberKind::Slot | MemberKind::Property => {
                let class_block = owner.block();
                let text = match member.kind {
                    MemberKind::Slot => class_block
                        .and_then(|b| b.slot(&member.name).or_else(|| b.param(&member.name))),
                    MemberKind::Property => class_block
                        .and_then(|b| b.prop(&member.name).or_else(|| b.param(&member.name))),
                    _ => class_block.and_then(|b| b.field(&member.name)),
                }
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
        }
    }

    /// What `receiver$name` refers to: `Class$new`, a member of the enclosing
    /// class through `self`, `private`, `super` or `.self`, or a member of the
    /// class `receiver` was constructed from in scope.
    pub(crate) fn member_target<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        name: &str,
        receiver: &Receiver,
    ) -> Option<Target<'a>> {
        let at = receiver.node.text_trimmed_range().start();
        let r6 = |kind: DefKind| kind == DefKind::R6Class;
        let (class, access) = match receiver.name.as_str() {
            "self" => (self.enclosing_class(path, file, at, r6)?, Access::Public),
            "private" => (self.enclosing_class(path, file, at, r6)?, Access::Private),
            "super" => (
                self.parent_of(self.enclosing_class(path, file, at, r6)?)?,
                Access::Any,
            ),
            ".self" => (
                self.enclosing_class(path, file, at, |k| k == DefKind::RefClass)?,
                Access::Any,
            ),
            other => {
                if let Some(class) = self
                    .lookup(other, Some(path))
                    .filter(|d| d.def().kind.has_dollar_members())
                {
                    return (name == "new").then_some(Target::New(class));
                }
                let class_name = receiver_class(&receiver.node, other)?;
                let class = self
                    .lookup(&class_name, Some(path))
                    .filter(|d| d.def().kind.has_dollar_members())?;
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

    /// What `receiver@name` refers to: a slot or property of the S4 or S7
    /// class `receiver` was constructed from, or that the method it is a
    /// parameter of dispatches on.
    pub(crate) fn slot_target<'a>(
        &'a self,
        path: &'a str,
        name: &str,
        receiver: &Receiver,
    ) -> Option<Target<'a>> {
        let class_name = receiver_class(&receiver.node, &receiver.name)?;
        let class = self
            .lookup(&class_name, Some(path))
            .filter(|d| d.def().kind.has_slots())?;
        let (owner, member) = self.find_member(class, name, Access::Any)?;
        Some(Target::Member {
            class,
            owner,
            member,
        })
    }

    /// Inside a reference class method, fields and other methods are used by
    /// bare name and take precedence over anything else of that name.
    pub(crate) fn ref_class_member<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        name: &str,
        at: TextSize,
    ) -> Option<Target<'a>> {
        if !file.has_ref_class() {
            return None;
        }
        let class = self.enclosing_class(path, file, at, |k| k == DefKind::RefClass)?;
        let (owner, member) = self.find_member(class, name, Access::Any)?;
        Some(Target::Member {
            class,
            owner,
            member,
        })
    }

    /// `Class$member`, `Class$new` or `Class@slot` by name, public members first.
    pub(crate) fn member_by_name<'a>(
        &'a self,
        name: &str,
        from_path: Option<&str>,
    ) -> Option<Target<'a>> {
        let (class, member, slot) = match name.split_once('@') {
            Some((class, slot)) => (class, slot, true),
            None => {
                let (class, member) = name.split_once('$')?;
                (class, member, false)
            }
        };
        let class = self.lookup(class, from_path).filter(|d| {
            if slot {
                d.def().kind.has_slots()
            } else {
                d.def().kind.has_dollar_members()
            }
        })?;
        if !slot && member == "new" {
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

    fn enclosing_class<'a>(
        &'a self,
        path: &'a str,
        file: &'a FileEntry,
        at: TextSize,
        kind: impl Fn(DefKind) -> bool,
    ) -> Option<DefRef<'a>> {
        let idx = file.defs.iter().position(|d| {
            kind(d.kind)
                && d.class
                    .as_ref()
                    .is_some_and(|c| c.runs_at(d.stmt_range, at))
        })?;
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

    /// The constructor's arguments. R6 and reference classes with an
    /// `initialize` take its formals. Otherwise S4 classes and reference
    /// classes take their ancestors' slots or fields before their own, and S7
    /// classes their properties; an S7 class below one with a custom
    /// constructor takes `...` for everything above it.
    fn class_formals(&self, def: DefRef<'_>) -> Vec<Formal> {
        let definition = def.def();
        if definition.kind.has_dollar_members() {
            if let Some((_, init)) = self.find_member(def, "initialize", Access::Any) {
                return init.formals().to_vec();
            }
            if definition.kind == DefKind::R6Class {
                return Vec::new();
            }
        }
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

    /// Constructor argument docs: `@param`, then `@slot` (S4), `@prop` (S7)
    /// or `@field` (reference classes), from the class and then its
    /// ancestors, so a subclass can redocument an inherited argument.
    fn class_param_docs(&self, def: DefRef<'_>, formals: &[Formal]) -> HashMap<String, String> {
        let kind = def.def().kind;
        let mut documented: HashMap<String, String> = HashMap::new();
        for class in self.chain(def) {
            let Some(block) = class.block() else { continue };
            for formal in formals {
                let text = block.param(&formal.name).or_else(|| match kind {
                    DefKind::S4Class => block.slot(&formal.name),
                    DefKind::RefClass => block.field(&formal.name),
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

/// `new("Class", ...)`, the usage of a class without a generator.
fn new_usage(class: &str, formals: &[Formal]) -> String {
    let mut args = vec![Formal {
        name: format!("\"{class}\""),
        default: None,
    }];
    args.extend(formals.iter().cloned());
    markdown::signature("new", &args).label
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

/// The class `name` holds at `node`: the one a method it is a parameter of
/// dispatches on, or the one its latest assignment before `node` constructs
/// (`Class$new(...)`, `Class(...)`, `new("Class", ...)`) in the innermost
/// enclosing scope that assigns it. Any other parameter hides outer
/// assignments.
fn receiver_class(node: &RSyntaxNode, name: &str) -> Option<String> {
    // Walking back from the statement holding `node` finds the latest
    // assignment first, so the usual case stops after a few statements.
    let mut inner = node.clone();
    for scope in node.ancestors().skip(1) {
        match scope.kind() {
            RSyntaxKind::R_STATEMENT_LIST => {
                let mut stmt = inner.prev_sibling();
                while let Some(current) = stmt {
                    if let Some(class) = assignment_to(&current, name) {
                        return class;
                    }
                    stmt = current.prev_sibling();
                }
            }
            RSyntaxKind::R_FUNCTION_DEFINITION => {
                let function = RFunctionDefinition::cast(scope.clone())?;
                if formals(&function).iter().any(|f| f.name == name) {
                    return dispatch_class(&function, name);
                }
            }
            _ => {}
        }
        inner = scope;
    }
    None
}

/// For a statement assigning to `name`: `Some(Some(class))` when the value
/// constructs an object, `Some(None)` for any other value.
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
    {
        return None;
    }
    let token = left.first_token()?;
    let target = token.text_trimmed();
    let target = target
        .strip_prefix('`')
        .and_then(|t| t.strip_suffix('`'))
        .unwrap_or(target);
    if target != name {
        return None;
    }
    let value = binary.last_child()?;
    Some(constructed_class(&value))
}

/// The class in `Class$new(...)`, `Class(...)` or `new("Class", ...)`. The
/// caller checks that it names a class.
fn constructed_class(value: &RSyntaxNode) -> Option<String> {
    if value.kind() != RSyntaxKind::R_CALL {
        return None;
    }
    let function = value.first_child()?;
    match function.kind() {
        RSyntaxKind::R_EXTRACT_EXPRESSION => {
            let class = function
                .first_child()
                .filter(|n| n.kind() == RSyntaxKind::R_IDENTIFIER)?;
            let member = function
                .last_child()
                .filter(|n| n.kind() == RSyntaxKind::R_IDENTIFIER)?;
            (member.text_trimmed() == "new").then(|| unquote(&class.text_trimmed().to_string()))
        }
        RSyntaxKind::R_IDENTIFIER | RSyntaxKind::R_NAMESPACE_EXPRESSION => {
            let callee = function.last_child().unwrap_or_else(|| function.clone());
            let callee = unquote(&callee.text_trimmed().to_string());
            if callee != "new" {
                return Some(callee);
            }
            let first = value
                .descendants()
                .find(|n| n.kind() == RSyntaxKind::R_ARGUMENT)?;
            let literal = first
                .last_child()
                .filter(|n| n.kind() == RSyntaxKind::R_STRING_VALUE)?
                .text_trimmed()
                .to_string();
            let quoted = literal.len() >= 2 && matches!(literal.as_bytes()[0], b'"' | b'\'');
            quoted.then(|| literal[1..literal.len() - 1].to_string())
        }
        _ => None,
    }
}
