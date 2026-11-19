//! Static recognition of S4, R6 and S7 definitions. Nothing is evaluated:
//! names, slots, properties and members are read from the calls as written,
//! and arguments are bound with R's matching rules, so named, positional and
//! S7 `:=` forms agree with what R would do at run time.

use std::collections::HashMap;

use air_r_syntax::{
    AnyRExpression, RBinaryExpression, RCall, RFunctionDefinition, RSyntaxKind, RSyntaxNode,
    RSyntaxToken,
};
use biome_rowan::{AstNode, AstNodeList, AstSeparatedList, TextRange};

use crate::call::match_args;
use crate::extract::{
    Callable, ClassInfo, DefKind, Definition, Formal, Member, MemberKind, MethodDef, formals,
    function_of, leading_block_span, unquote,
};

pub(crate) enum Item {
    Def(Definition),
    Method(MethodDef),
    /// `X$methods(...)` adding methods to the reference class `X`.
    RefMethods {
        class: String,
        members: Vec<Member>,
        range: TextRange,
    },
}

const SET_CLASS: &[&str] = &[
    "Class",
    "representation",
    "prototype",
    "contains",
    "validity",
    "access",
    "where",
    "version",
    "sealed",
    "package",
    "S3methods",
    "slots",
];
const SET_GENERIC: &[&str] = &[
    "name",
    "def",
    "group",
    "valueClass",
    "where",
    "package",
    "signature",
    "useAsDefault",
    "genericFunction",
    "simpleInheritanceOnly",
];
const SET_METHOD: &[&str] = &[
    "f",
    "signature",
    "definition",
    "where",
    "valueClass",
    "sealed",
];
const R6_CLASS: &[&str] = &[
    "classname",
    "public",
    "private",
    "active",
    "inherit",
    "lock_objects",
    "class",
    "portable",
    "lock_class",
    "cloneable",
    "parent_env",
];
const NEW_CLASS: &[&str] = &[
    "name",
    "parent",
    "package",
    "properties",
    "abstract",
    "constructor",
    "validator",
];
const NEW_GENERIC: &[&str] = &["name", "dispatch_args", "fun"];
const NEW_PROPERTY: &[&str] = &["class", "getter", "setter", "validator", "default", "name"];
const METHOD_ASSIGN: &[&str] = &["generic", "signature"];
const SET_REF_CLASS: &[&str] = &[
    "Class",
    "fields",
    "contains",
    "methods",
    "where",
    "inheritPackage",
    "...",
];
const SET_VALIDITY: &[&str] = &["Class", "method", "where"];
const NEW_EXTERNAL_GENERIC: &[&str] = &["package", "name", "dispatch_args", "version"];

/// The name a definition is bound to, and whether it came from S7's `:=`,
/// which passes it to the call as `name =`.
struct Binding {
    name: String,
    range: TextRange,
    walrus: bool,
}

/// Every top-level statement that is not a plain function definition comes
/// through here, so names are compared before anything is allocated.
pub(crate) fn recognise(expr: &AnyRExpression) -> Option<Item> {
    match expr {
        AnyRExpression::RCall(call) => {
            if let Some(item) = ref_methods(call) {
                return Some(item);
            }
            match callee_token(call)?.text_trimmed() {
                "setGeneric" => s4_generic(call, None, call.syntax()),
                "setClass" => s4_class(call, None, call.syntax()),
                "setRefClass" => ref_class(call, None, call.syntax()),
                "setMethod" => s4_method(call, call.syntax()),
                _ => None,
            }
        }
        AnyRExpression::RBinaryExpression(binary) => assignment(binary),
        _ => None,
    }
}

fn assignment(binary: &RBinaryExpression) -> Option<Item> {
    let walrus = match binary.operator().ok()?.text_trimmed() {
        "<-" | "=" | "<<-" => false,
        ":=" => true,
        _ => return None,
    };
    let target = binary.left().ok()?;
    let value = binary.right().ok()?;
    let stmt = binary.syntax();

    if let AnyRExpression::RCall(target_call) = &target {
        return (!walrus && callee_token(target_call)?.text_trimmed() == "method")
            .then(|| s7_method(target_call, value, stmt))
            .flatten();
    }
    if let AnyRExpression::RBinaryExpression(union) = &value {
        return (!walrus)
            .then(|| union_pipe(union, &target, stmt))
            .flatten();
    }
    let AnyRExpression::RCall(call) = value else {
        return None;
    };
    let callee = callee_token(&call)?;
    let recogniser: fn(&RCall, Binding, &RSyntaxNode) -> Option<Item> = match callee.text_trimmed()
    {
        "new_class" => s7_class,
        "new_generic" => s7_generic,
        "setGeneric" => |call, binding, stmt| s4_generic(call, Some(binding), stmt),
        // Neither has a `name` argument, so `:=` would fail at run time.
        "setClass" if !walrus => |call, binding, stmt| s4_class(call, Some(binding), stmt),
        "R6Class" if !walrus => r6_class,
        "setRefClass" if !walrus => |call, binding, stmt| ref_class(call, Some(binding), stmt),
        // `new_union(...)` has no `name` argument either.
        "new_union" if !walrus => s7_union,
        "new_external_generic" => s7_external_generic,
        _ => return None,
    };
    let ident = target.as_r_identifier()?;
    let binding = Binding {
        name: unquote(&ident.syntax().text_trimmed().to_string()),
        range: ident.syntax().text_trimmed_range(),
        walrus,
    };
    recogniser(&call, binding, stmt)
}

/// `setClass("Circle", representation(r = "numeric"), contains = "Shape")`,
/// optionally assigned to a generator that constructs it.
fn s4_class(call: &RCall, binding: Option<Binding>, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, SET_CLASS, false);
    let class_arg = args.get("Class")?;
    let class_name = string_value(class_arg)?;

    let mut slots: Vec<String> = Vec::new();
    let mut parents: Vec<String> = Vec::new();
    for key in ["representation", "slots"] {
        for (name, value) in args.get(key).map(entries).unwrap_or_default() {
            match (name, string_value(&value)) {
                (Some(name), _) => slots.push(name),
                // Unnamed strings are superclasses in `representation()` and
                // slot names of class "ANY" in `slots =`.
                (None, Some(string)) if key == "representation" => parents.push(string),
                (None, Some(string)) => slots.push(string),
                (None, None) => {}
            }
        }
    }
    parents.extend(args.get("contains").map(strings).unwrap_or_default());
    let prototype: HashMap<String, String> = args
        .get("prototype")
        .map(entries)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, value)| Some((name?, text(&value))))
        .collect();

    let members: Vec<Member> = slots
        .into_iter()
        .map(|name| {
            let default = prototype.get(&name).cloned();
            Member::new(name, MemberKind::Slot, false, default, None, None)
        })
        .collect();
    let callable = binding.is_some();
    let (name, range) = match binding {
        Some(binding) => (binding.name, binding.range),
        None => (class_name, class_arg.syntax().text_trimmed_range()),
    };
    let info = ClassInfo {
        parent: parents.into_iter().find(|p| p != "VIRTUAL"),
        members,
        custom_constructor: false,
        callable,
        ..ClassInfo::default()
    };
    Some(Item::Def(class_def(
        name,
        range,
        DefKind::S4Class,
        info,
        stmt,
    )))
}

/// `setGeneric("area", function(shape) standardGeneric("area"))`. Without a
/// `def` it only makes an existing function generic, which is not ours.
fn s4_generic(call: &RCall, binding: Option<Binding>, stmt: &RSyntaxNode) -> Option<Item> {
    let walrus = binding.as_ref().is_some_and(|b| b.walrus);
    let args = bind(call, SET_GENERIC, walrus);
    let function = function_of(args.get("def")?.clone())?;
    // The generic is named by `name`; an assignment's target only holds that string.
    let (name, range) = match (args.get("name"), binding) {
        (Some(arg), _) if !walrus => (string_value(arg)?, arg.syntax().text_trimmed_range()),
        (_, Some(binding)) => (binding.name, binding.range),
        _ => return None,
    };
    Some(Item::Def(Definition::new(
        name,
        range,
        DefKind::S4Generic,
        Callable::Function(function),
        None,
        stmt,
    )))
}

/// `setMethod("area", "Circle", function(shape) ...)`.
fn s4_method(call: &RCall, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, SET_METHOD, false);
    let generic = string_value(args.get("f")?)?;
    let classes = args.get("signature").map(strings).unwrap_or_default();
    Some(Item::Method(MethodDef::new(generic, classes, stmt)))
}

/// `Person <- R6Class("Person", public = list(...), inherit = Parent)`.
fn r6_class(call: &RCall, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, R6_CLASS, false);
    let mut members = Vec::new();
    for (list, private) in [("public", false), ("private", true), ("active", false)] {
        let Some(AnyRExpression::RCall(list_call)) = args.get(list) else {
            continue;
        };
        if callee_name(list_call).as_deref() != Some("list") {
            continue;
        }
        for arg in call_arguments(list_call) {
            let Some(name) = arg.name else { continue };
            let function = arg.value.clone().and_then(function_of);
            let kind = match (list, &function) {
                ("active", _) => MemberKind::Active,
                (_, Some(_)) => MemberKind::Method,
                (_, None) => MemberKind::Field,
            };
            members.push(Member::new(
                name,
                kind,
                private,
                None,
                function,
                leading_block_span(&arg.node),
            ));
        }
    }
    let info = ClassInfo {
        parent: args.get("inherit").and_then(identifier),
        members,
        custom_constructor: false,
        callable: false,
        ..ClassInfo::default()
    };
    Some(Item::Def(class_def(
        binding.name,
        binding.range,
        DefKind::R6Class,
        info,
        stmt,
    )))
}

/// `Dog <- new_class("Dog", parent = Animal, properties = list(...))` and
/// `Dog := new_class(...)`.
fn s7_class(call: &RCall, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, NEW_CLASS, binding.walrus);
    let members: Vec<Member> = args
        .get("properties")
        .map(entries)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, value)| {
            Some(Member::new(
                name?,
                MemberKind::Property,
                false,
                property_default(&value),
                None,
                None,
            ))
        })
        .collect();
    let constructor = args.get("constructor").cloned().and_then(function_of);
    let info = ClassInfo {
        parent: args.get("parent").and_then(identifier),
        members,
        custom_constructor: constructor.is_some(),
        callable: true,
        ..ClassInfo::default()
    };
    let def = match constructor {
        Some(function) => Definition::new(
            binding.name,
            binding.range,
            DefKind::S7Class,
            Callable::Function(function),
            Some(info),
            stmt,
        ),
        None => class_def(binding.name, binding.range, DefKind::S7Class, info, stmt),
    };
    Some(Item::Def(def))
}

/// The default in `new_property(class_double, default = 0)`; a bare class
/// such as `class_double` has none written.
fn property_default(value: &AnyRExpression) -> Option<String> {
    let AnyRExpression::RCall(call) = value else {
        return None;
    };
    if callee_name(call).as_deref() != Some("new_property") {
        return None;
    }
    bind(call, NEW_PROPERTY, false).get("default").map(text)
}

/// `speak <- new_generic("speak", "x")`, `speak := new_generic("x")`, or with
/// an explicit `fun`.
fn s7_generic(call: &RCall, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, NEW_GENERIC, binding.walrus);
    let callable = match args.get("fun").cloned().and_then(function_of) {
        Some(function) => Callable::Function(function),
        None => {
            let dispatch = strings(args.get("dispatch_args")?);
            if dispatch.is_empty() {
                return None;
            }
            Callable::Formals(
                dispatch
                    .into_iter()
                    .chain(std::iter::once("...".to_string()))
                    .map(|name| Formal {
                        name,
                        default: None,
                    })
                    .collect(),
            )
        }
    };
    Some(Item::Def(Definition::new(
        binding.name,
        binding.range,
        DefKind::S7Generic,
        callable,
        None,
        stmt,
    )))
}

/// `method(speak, Dog) <- function(x) ...`. Assigning `NULL` unregisters.
fn s7_method(target: &RCall, value: AnyRExpression, stmt: &RSyntaxNode) -> Option<Item> {
    function_of(value)?;
    let args = bind(target, METHOD_ASSIGN, false);
    let generic = identifier(args.get("generic")?)?;
    let classes = match args.get("signature") {
        Some(AnyRExpression::RCall(call)) if callee_name(call).as_deref() == Some("list") => {
            call_arguments(call)
                .iter()
                .filter_map(|arg| arg.value.as_ref().map(text))
                .collect()
        }
        Some(other) => vec![text(other)],
        None => Vec::new(),
    };
    Some(Item::Method(MethodDef::new(generic, classes, stmt)))
}

/// `Account <- setRefClass("Account", fields = list(...), methods = list(...))`,
/// optionally assigned to a generator that constructs it.
fn ref_class(call: &RCall, binding: Option<Binding>, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, SET_REF_CLASS, false);
    let class_arg = args.get("Class")?;
    let class_name = string_value(class_arg)?;
    let mut members: Vec<Member> = Vec::new();
    for (name, value) in args.get("fields").map(entries).unwrap_or_default() {
        // `c("a", "b")` names fields of class "ANY".
        let Some(name) = name.or_else(|| string_value(&value)) else {
            continue;
        };
        members.push(Member::new(
            name,
            MemberKind::Field,
            false,
            None,
            None,
            None,
        ));
    }
    if let Some(AnyRExpression::RCall(methods)) = args.get("methods") {
        members.extend(ref_method_members(methods));
    }
    let callable = binding.is_some();
    let (name, range) = match binding {
        Some(binding) => (binding.name, binding.range),
        None => (class_name, class_arg.syntax().text_trimmed_range()),
    };
    let info = ClassInfo {
        parent: args
            .get("contains")
            .map(strings)
            .unwrap_or_default()
            .into_iter()
            .find(|p| p != "VIRTUAL" && p != "envRefClass"),
        members,
        callable,
        ..ClassInfo::default()
    };
    Some(Item::Def(class_def(
        name,
        range,
        DefKind::RefClass,
        info,
        stmt,
    )))
}

/// The methods in `list(name = function(...) ...)`, documented by a `#'`
/// block or a docstring.
fn ref_method_members(list: &RCall) -> Vec<Member> {
    if callee_name(list).as_deref() != Some("list") {
        return Vec::new();
    }
    method_members(call_arguments(list))
}

fn method_members(args: Vec<Arg>) -> Vec<Member> {
    args.into_iter()
        .filter_map(|arg| {
            let function = arg.value.clone().and_then(function_of)?;
            let docstring = docstring(&function);
            Some(
                Member::new(
                    arg.name?,
                    MemberKind::Method,
                    false,
                    None,
                    Some(function),
                    leading_block_span(&arg.node),
                )
                .with_docstring(docstring),
            )
        })
        .collect()
}

/// `Account$methods(deposit = function(x) ...)` or `Account$methods(list(...))`.
fn ref_methods(call: &RCall) -> Option<Item> {
    let AnyRExpression::RExtractExpression(extract) = call.function().ok()? else {
        return None;
    };
    if extract.operator().ok()?.kind() != RSyntaxKind::DOLLAR
        || extract.right().ok()?.syntax().text_trimmed() != "methods"
    {
        return None;
    }
    let class = identifier(&extract.left().ok()?)?;
    let args = call_arguments(call);
    let members = match args.as_slice() {
        [
            Arg {
                name: None,
                value: Some(AnyRExpression::RCall(list)),
                ..
            },
        ] => ref_method_members(list),
        _ => method_members(args),
    };
    Some(Item::RefMethods {
        class,
        members,
        range: call.syntax().text_trimmed_range(),
    })
}

/// A string as the first statement of a braced function body.
fn docstring(function: &RFunctionDefinition) -> Option<String> {
    let AnyRExpression::RBracedStatements(body) = function.body().ok()? else {
        return None;
    };
    let first = body.statements().iter().next()?;
    let expr = first.as_r_expression_statement()?.expression().ok()?;
    string_value(&expr)
}

/// `Number <- new_union(class_integer, class_double)`.
fn s7_union(call: &RCall, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let classes: Vec<String> = call_arguments(call)
        .iter()
        .filter_map(|arg| arg.value.as_ref().map(text))
        .collect();
    union_def(classes, binding, stmt)
}

/// `Number <- class_integer | class_double`. Only operands that are plainly
/// classes count, so `x <- a | b` stays a logical or.
fn union_pipe(
    binary: &RBinaryExpression,
    target: &AnyRExpression,
    stmt: &RSyntaxNode,
) -> Option<Item> {
    let mut classes = Vec::new();
    let mut pending = vec![AnyRExpression::RBinaryExpression(binary.clone())];
    while let Some(expr) = pending.pop() {
        match expr {
            AnyRExpression::RBinaryExpression(or) if or.operator().ok()?.text_trimmed() == "|" => {
                pending.push(or.right().ok()?);
                pending.push(or.left().ok()?);
            }
            AnyRExpression::RNullExpression(_) => classes.push("NULL".to_string()),
            other => classes.push(identifier(&other)?),
        }
    }
    if !classes
        .iter()
        .any(|c| c.starts_with("class_") || c == "NULL")
    {
        return None;
    }
    let ident = target.as_r_identifier()?;
    let binding = Binding {
        name: unquote(&ident.syntax().text_trimmed().to_string()),
        range: ident.syntax().text_trimmed_range(),
        walrus: false,
    };
    union_def(classes, binding, stmt)
}

fn union_def(classes: Vec<String>, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let info = ClassInfo {
        union_of: classes,
        ..ClassInfo::default()
    };
    Some(Item::Def(Definition::new(
        binding.name,
        binding.range,
        DefKind::S7Union,
        Callable::Formals(Vec::new()),
        Some(info),
        stmt,
    )))
}

/// `median_ext <- new_external_generic("stats", "median", "x")` and
/// `median := new_external_generic("stats", dispatch_args = "x")`.
fn s7_external_generic(call: &RCall, binding: Binding, stmt: &RSyntaxNode) -> Option<Item> {
    let args = bind(call, NEW_EXTERNAL_GENERIC, binding.walrus);
    let package = string_value(args.get("package")?)?;
    let name = if binding.walrus {
        binding.name.clone()
    } else {
        string_value(args.get("name")?)?
    };
    let dispatch = strings(args.get("dispatch_args")?);
    let formals = dispatch
        .into_iter()
        .chain(std::iter::once("...".to_string()))
        .map(|name| Formal {
            name,
            default: None,
        })
        .collect();
    let mut def = Definition::new(
        binding.name,
        binding.range,
        DefKind::S7ExternalGeneric,
        Callable::Formals(formals),
        None,
        stmt,
    );
    def.external = Some(format!("{package}::{name}"));
    Some(Item::Def(def))
}

/// The class a method definition dispatches `param` on:
/// `setMethod("f", "Circle", function(x) ...)`, `setValidity("Circle",
/// function(object) ...)` and `method(f, Circle) <- function(x) ...`.
/// Unnamed signature classes go to the function's formals in order.
pub(crate) fn dispatch_class(function: &RFunctionDefinition, param: &str) -> Option<String> {
    let node = function.syntax();
    let parent = node.parent()?;
    let params: Vec<String> = formals(function)
        .into_iter()
        .map(|f| f.name)
        .filter(|n| n != "...")
        .collect();
    let positional = |classes: Vec<String>| {
        let at = params.iter().position(|p| p == param)?;
        classes.into_iter().nth(at)
    };
    if parent.kind() == RSyntaxKind::R_BINARY_EXPRESSION {
        let binary = RBinaryExpression::cast(parent)?;
        let AnyRExpression::RCall(target) = binary.left().ok()? else {
            return None;
        };
        if binary.right().ok()?.syntax() != node
            || callee_name(&target).as_deref() != Some("method")
        {
            return None;
        }
        let args = bind(&target, METHOD_ASSIGN, false);
        let classes = match args.get("signature")? {
            AnyRExpression::RCall(list) if callee_name(list).as_deref() == Some("list") => {
                call_arguments(list)
                    .iter()
                    .filter_map(|arg| arg.value.as_ref().and_then(identifier))
                    .collect()
            }
            other => vec![identifier(other)?],
        };
        return positional(classes);
    }
    let call = parent.ancestors().find_map(RCall::cast)?;
    let defines = |value: Option<&AnyRExpression>| value.is_some_and(|v| v.syntax() == node);
    match callee_token(&call)?.text_trimmed() {
        "setMethod" => {
            let args = bind(&call, SET_METHOD, false);
            if !defines(args.get("definition")) {
                return None;
            }
            let entries = entries(args.get("signature")?);
            if let Some(class) = entries
                .iter()
                .find(|(name, _)| name.as_deref() == Some(param))
                .and_then(|(_, value)| string_value(value))
            {
                return Some(class);
            }
            positional(
                entries
                    .iter()
                    .filter(|(name, _)| name.is_none())
                    .filter_map(|(_, value)| string_value(value))
                    .collect(),
            )
        }
        "setValidity" => {
            let args = bind(&call, SET_VALIDITY, false);
            if !defines(args.get("method")) || params.first().map(String::as_str) != Some(param) {
                return None;
            }
            string_value(args.get("Class")?)
        }
        _ => None,
    }
}

/// A class whose formals are its slots, properties or fields.
fn class_def(
    name: String,
    range: TextRange,
    kind: DefKind,
    info: ClassInfo,
    stmt: &RSyntaxNode,
) -> Definition {
    // Slots, properties and reference class fields are constructor arguments;
    // methods are not, and R6 classes construct through `initialize`.
    let formals = if kind == DefKind::R6Class {
        Vec::new()
    } else {
        info.members
            .iter()
            .filter(|member| member.kind != MemberKind::Method)
            .map(|member| Formal {
                name: member.name.clone(),
                default: member.default.clone(),
            })
            .collect()
    };
    Definition::new(
        name,
        range,
        kind,
        Callable::Formals(formals),
        Some(info),
        stmt,
    )
}

struct Arg {
    name: Option<String>,
    value: Option<AnyRExpression>,
    node: RSyntaxNode,
}

fn call_arguments(call: &RCall) -> Vec<Arg> {
    let Ok(arguments) = call.arguments() else {
        return Vec::new();
    };
    arguments
        .items()
        .iter()
        .filter_map(Result::ok)
        .map(|arg| Arg {
            name: arg
                .name_clause()
                .and_then(|clause| clause.name().ok())
                .map(|name| strip_quotes(&name.syntax().text_trimmed().to_string())),
            value: arg.value(),
            node: arg.syntax().clone(),
        })
        .collect()
}

/// The call's arguments bound to `formals` by R's matching rules. `walrus`
/// adds the `name =` argument that S7's `:=` passes.
fn bind(
    call: &RCall,
    formals: &[&'static str],
    walrus: bool,
) -> HashMap<&'static str, AnyRExpression> {
    let args = call_arguments(call);
    let mut names: Vec<Option<String>> = args.iter().map(|a| a.name.clone()).collect();
    if walrus {
        names.push(Some("name".to_string()));
    }
    let mut bound = HashMap::new();
    for (arg, formal) in args.iter().zip(match_args(formals, &names)) {
        if let (Some(value), Some(formal)) = (&arg.value, formal) {
            bound
                .entry(formals[formal])
                .or_insert_with(|| value.clone());
        }
    }
    bound
}

/// The function name of a call, ignoring any `pkg::` prefix.
fn callee_name(call: &RCall) -> Option<String> {
    identifier(&call.function().ok()?)
}

/// The token naming a call's function, ignoring any `pkg::` prefix.
fn callee_token(call: &RCall) -> Option<RSyntaxToken> {
    match call.function().ok()? {
        AnyRExpression::RIdentifier(ident) => ident.name_token().ok(),
        AnyRExpression::RNamespaceExpression(ns) => ns.right().ok()?.syntax().first_token(),
        _ => None,
    }
}

/// A plain or namespaced identifier: `Dog`, `S7::class_character`.
fn identifier(expr: &AnyRExpression) -> Option<String> {
    match expr {
        AnyRExpression::RIdentifier(ident) => {
            Some(unquote(&ident.syntax().text_trimmed().to_string()))
        }
        AnyRExpression::RNamespaceExpression(ns) => Some(unquote(
            &ns.right().ok()?.syntax().text_trimmed().to_string(),
        )),
        _ => None,
    }
}

/// `(name, value)` for each argument of `c()`, `list()`, `representation()`,
/// `prototype()` or `signature()`; a lone value is one unnamed entry.
fn entries(expr: &AnyRExpression) -> Vec<(Option<String>, AnyRExpression)> {
    if let AnyRExpression::RCall(call) = expr
        && matches!(
            callee_name(call).as_deref(),
            Some("c" | "list" | "representation" | "prototype" | "signature")
        )
    {
        return call_arguments(call)
            .into_iter()
            .filter_map(|arg| Some((arg.name, arg.value?)))
            .collect();
    }
    vec![(None, expr.clone())]
}

/// Every string in a string or a vector of strings, in order.
fn strings(expr: &AnyRExpression) -> Vec<String> {
    entries(expr)
        .iter()
        .filter_map(|(_, value)| string_value(value))
        .collect()
}

fn string_value(expr: &AnyRExpression) -> Option<String> {
    let string = expr.as_any_r_value()?.as_r_string_value()?;
    let raw = string.value().ok()?.text_trimmed().to_string();
    let first = raw.chars().next()?;
    // Raw strings (`r"(...)"`) are not worth decoding for a class name.
    matches!(first, '"' | '\'').then(|| strip_quotes(&raw))
}

fn strip_quotes(text: &str) -> String {
    for quote in ['"', '\'', '`'] {
        if let Some(inner) = text.strip_prefix(quote).and_then(|t| t.strip_suffix(quote)) {
            return inner.to_string();
        }
    }
    text.to_string()
}

fn text(expr: &AnyRExpression) -> String {
    expr.syntax().text_trimmed().to_string()
}

#[cfg(test)]
mod tests {
    use crate::extract::{DefKind, MemberKind, parse};

    fn defs(text: &str) -> Vec<(String, DefKind, Vec<String>, Option<String>)> {
        parse(text)
            .defs
            .iter()
            .map(|d| {
                (
                    d.name.clone(),
                    d.kind,
                    d.formals().iter().map(|f| f.name.clone()).collect(),
                    d.parent().map(str::to_string),
                )
            })
            .collect()
    }

    fn methods(text: &str) -> Vec<(String, Vec<String>)> {
        parse(text)
            .methods
            .into_iter()
            .map(|m| (m.generic, m.classes))
            .collect()
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn walrus_injects_name_so_positional_arguments_shift() {
        let got = defs("Dog := new_class(Animal, properties = list(good = class_logical))\n");
        assert_eq!(
            got,
            [(
                "Dog".into(),
                DefKind::S7Class,
                strings(&["good"]),
                Some("Animal".into())
            )]
        );
        let got = defs("describe := new_generic(c(\"x\", \"y\"))\n");
        assert_eq!(got[0].2, strings(&["x", "y", "..."]));
    }

    #[test]
    fn s7_without_walrus_takes_the_name_positionally() {
        let got = defs(
            "speak <- S7::new_generic(\"speak\", \"x\")\nDog <- S7::new_class(\"Dog\", Animal)\n",
        );
        assert_eq!(got[0].1, DefKind::S7Generic);
        assert_eq!(got[0].2, strings(&["x", "..."]));
        assert_eq!(got[1].3.as_deref(), Some("Animal"));
    }

    #[test]
    fn s7_generic_with_fun_uses_its_formals() {
        let got = defs("g <- new_generic(\"g\", \"x\", function(x, y = 1, ...) S7_dispatch())\n");
        assert_eq!(got[0].2, strings(&["x", "y", "..."]));
        assert!(defs("g <- new_generic(\"g\")\n").is_empty());
    }

    #[test]
    fn s4_classes_read_representation_slots_and_contains() {
        let got = defs(
            "setClass(\"A\", representation(\"VIRTUAL\", x = \"numeric\"))\n\
             B <- methods::setClass(\"B\", contains = \"A\", slots = c(y = \"character\", \"z\"))\n\
             setClass(\"C\", representation(\"A\", w = \"list\"))\n",
        );
        assert_eq!(
            got[0],
            ("A".into(), DefKind::S4Class, strings(&["x"]), None)
        );
        assert_eq!(got[1].2, strings(&["y", "z"]));
        assert_eq!(got[1].3.as_deref(), Some("A"));
        assert_eq!(got[2].3.as_deref(), Some("A"));
    }

    #[test]
    fn s4_generics_need_a_definition() {
        assert_eq!(
            defs("setGeneric(def = function(obj) standardGeneric(\"size\"), name = \"size\")\n")[0]
                .0,
            "size"
        );
        assert!(defs("setGeneric(\"summary\")\n").is_empty());
    }

    #[test]
    fn walrus_needs_a_name_argument() {
        assert!(defs("P := R6Class(\"P\")\nC := setClass(\"C\")\n").is_empty());
    }

    #[test]
    fn r6_members_by_list() {
        let parsed = parse(
            "P <- R6::R6Class(\"P\", public = list(x = 1, f = function(a) a), \
             private = list(g = function() 1), active = list(h = function() 2), inherit = Base)\n",
        );
        let def = &parsed.defs[0];
        assert_eq!(def.kind, DefKind::R6Class);
        assert_eq!(def.parent(), Some("Base"));
        let members: Vec<_> = def
            .members()
            .iter()
            .map(|m| (m.name.as_str(), m.kind, m.private))
            .collect();
        assert_eq!(
            members,
            [
                ("x", MemberKind::Field, false),
                ("f", MemberKind::Method, false),
                ("g", MemberKind::Method, true),
                ("h", MemberKind::Active, false),
            ]
        );
    }

    #[test]
    fn methods_for_s4_and_s7() {
        let text = "setMethod(\"area\", signature(\"Circle\"), function(shape) 1)\n\
                    setMethod(f = \"show\", \"Circle\", function(object) 1)\n\
                    method(speak, Dog) <- function(x) 1\n\
                    S7::method(combine, list(Dog, Cat)) <- function(x, y) 1\n\
                    method(speak, Cat) <- NULL\n";
        assert_eq!(
            methods(text),
            [
                ("area".into(), strings(&["Circle"])),
                ("show".into(), strings(&["Circle"])),
                ("speak".into(), strings(&["Dog"])),
                ("combine".into(), strings(&["Dog", "Cat"])),
            ]
        );
    }

    #[test]
    fn reference_classes_take_fields_and_later_methods() {
        let parsed = parse(
            "A <- setRefClass(\"A\", fields = c(\"x\", y = \"numeric\"), contains = \"Base\",\n\
             methods = list(f = function() { \"Doc.\"; 1 }))\n\
             A$methods(g = function(z) z)\n\
             B$methods(h = function() 1)\n\
             A$methods(list(k = function() 2))\n",
        );
        let def = &parsed.defs[0];
        assert_eq!(def.kind, DefKind::RefClass);
        assert_eq!(def.parent(), Some("Base"));
        let members: Vec<_> = def
            .members()
            .iter()
            .map(|m| (m.name.as_str(), m.kind))
            .collect();
        assert_eq!(
            members,
            [
                ("x", MemberKind::Field),
                ("y", MemberKind::Field),
                ("f", MemberKind::Method),
                ("g", MemberKind::Method),
                ("k", MemberKind::Method),
            ]
        );
        let formals: Vec<_> = def.formals().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(formals, ["x", "y"]);
        let docstring = def.members()[2]
            .block("")
            .and_then(|b| b.description.clone());
        assert_eq!(docstring.as_deref(), Some("Doc."));
    }

    #[test]
    fn unions_need_plain_classes() {
        assert_eq!(
            defs("N <- class_integer | class_double | NULL\n")[0].1,
            DefKind::S7Union
        );
        assert_eq!(defs("N <- S7::new_union(A, B)\n")[0].1, DefKind::S7Union);
        assert!(defs("x <- a | b\nx <- class_a | f(b)\nN := new_union(A)\n").is_empty());
    }

    #[test]
    fn external_generics_name_their_target() {
        let parsed = parse(
            "m <- new_external_generic(\"stats\", \"median\", \"x\")\n\
             median := new_external_generic(\"stats\", dispatch_args = \"x\")\n",
        );
        let got: Vec<_> = parsed
            .defs
            .iter()
            .map(|d| (d.name.as_str(), d.kind, d.external.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("m", DefKind::S7ExternalGeneric, Some("stats::median")),
                ("median", DefKind::S7ExternalGeneric, Some("stats::median")),
            ]
        );
    }

    #[test]
    fn dispatch_classes_of_method_parameters() {
        use air_r_syntax::RFunctionDefinition;
        use biome_rowan::AstNode;
        let class_of = |text: &str, param: &str| {
            let root = parse(text).root;
            let function = root.descendants().find_map(RFunctionDefinition::cast)?;
            super::dispatch_class(&function, param)
        };
        let set_method = "setMethod(\"f\", signature(\"A\", \"B\"), function(x, y, ...) 1)\n";
        assert_eq!(class_of(set_method, "y").as_deref(), Some("B"));
        let named = "setMethod(\"f\", c(y = \"B\"), function(x, y) 1)\n";
        assert_eq!(class_of(named, "y").as_deref(), Some("B"));
        assert_eq!(class_of(named, "x"), None);
        let s7 = "method(f, list(A, B)) <- function(x, y) 1\n";
        assert_eq!(class_of(s7, "y").as_deref(), Some("B"));
        let validity = "setValidity(\"A\", function(object) TRUE)\n";
        assert_eq!(class_of(validity, "object").as_deref(), Some("A"));
        assert_eq!(class_of("lapply(x, function(x) 1)\n", "x"), None);
    }

    #[test]
    fn plain_assignments_are_untouched() {
        assert!(defs("x <- list(1)\ny := 2\nz <- new_thing(\"z\")\n").is_empty());
    }
}
