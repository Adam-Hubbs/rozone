mod common;

use common::mark;
use rozone_core::{DocSource, HoverKind, Index, content_hash};

fn index_of(files: &[(&str, &str)]) -> Index {
    let mut index = Index::new();
    for (path, text) in files {
        index.update_file(path, text);
    }
    index
}

const WMEAN: &str = "#' Weighted mean\n#'\n#' @param x Values.\nwmean <- function(x, w = 1) NULL\n";

fn offset_of(text: &str, needle: &str) -> u32 {
    let byte = text
        .find(needle)
        .unwrap_or_else(|| panic!("{needle} not in text"));
    text[..byte].encode_utf16().count() as u32
}

#[test]
fn resolves_in_the_same_file_first() {
    let a = "#' From a\na_fn <- function(x) NULL\n";
    let b = "#' From b\na_fn <- function(x) NULL\nuse <- a_fn(1)\n";
    let index = index_of(&[("/a.R", a), ("/b.R", b)]);
    let hover = index.hover("/b.R", offset_of(b, "a_fn(1)")).unwrap();
    assert!(hover.markdown.contains("From b"), "{}", hover.markdown);
    assert_eq!(
        index
            .documentation("a_fn", Some("/b.R"))
            .unwrap()
            .lines()
            .next(),
        Some("_a_fn {b.R}_")
    );
    assert_eq!(
        index
            .documentation("a_fn", Some("/a.R"))
            .unwrap()
            .lines()
            .next(),
        Some("_a_fn {a.R}_")
    );
}

#[test]
fn otherwise_the_lexicographically_smallest_path() {
    let user = "a_fn(1)\n";
    let index = index_of(&[
        ("/z.R", "#' From z\na_fn <- function(x) NULL\n"),
        ("/m.R", "#' From m\na_fn <- function(x) NULL\n"),
        ("/user.R", user),
    ]);
    let hover = index.hover("/user.R", 1).unwrap();
    assert!(hover.markdown.contains("From m"));
    assert_eq!(
        index.documentation("a_fn", None).unwrap().lines().next(),
        Some("_a_fn {m.R}_")
    );
    assert_eq!(
        index
            .documentation("a_fn", Some("/nowhere.R"))
            .unwrap()
            .lines()
            .next(),
        Some("_a_fn {m.R}_")
    );
}

#[test]
fn removing_and_updating_files_updates_resolution() {
    let mut index = index_of(&[
        ("/m.R", "#' From m\nf <- function(x) NULL\n"),
        ("/z.R", "#' From z\nf <- function(x) NULL\n"),
        ("/user.R", "f(1)\n"),
    ]);
    index.remove_file("/m.R");
    assert!(
        index
            .hover("/user.R", 1)
            .unwrap()
            .markdown
            .contains("From z")
    );
    index.update_file("/z.R", "#' New z\nf <- function(x) NULL\n");
    assert!(
        index
            .hover("/user.R", 1)
            .unwrap()
            .markdown
            .contains("New z")
    );
    index.update_file("/z.R", "f <- function(x) NULL\n");
    assert!(index.hover("/user.R", 1).is_none());
    index.remove_file("/z.R");
    assert!(index.documented_functions().is_empty());
    index.remove_file("/never-added.R");
}

#[test]
fn undocumented_same_file_definition_shadows_documented_one_elsewhere() {
    let index = index_of(&[
        ("/a.R", "#' Doc\nf <- function(x) NULL\n"),
        ("/b.R", "f <- function(x) NULL\nf(1)\n"),
    ]);
    assert!(index.hover("/b.R", 1).is_none());
}

#[test]
fn hover_kinds() {
    let text = "#' Doc\nwmean <- function(x) NULL\nwmean(1)\nmap(xs, wmean)\n";
    let index = index_of(&[("/s.R", text)]);
    let kind = |needle: &str, delta: u32| {
        index
            .hover("/s.R", offset_of(text, needle) + delta)
            .map(|h| h.kind)
    };
    assert_eq!(kind("wmean <-", 2), Some(HoverKind::Definition));
    assert_eq!(kind("wmean(1)", 2), Some(HoverKind::Call));
    assert_eq!(kind("wmean)", 2), Some(HoverKind::Identifier));
    assert_eq!(
        kind("wmean)", 0),
        Some(HoverKind::Identifier),
        "start of identifier"
    );
    assert_eq!(
        kind("wmean)", 5),
        Some(HoverKind::Identifier),
        "end of identifier"
    );
}

#[test]
fn hover_range_is_utf16() {
    let marked = mark("x <- \"😀😀\"; ¦wmean(1)\n");
    let text = format!("#' Doc\nwmean <- function(x) NULL\n{}", marked.text);
    let index = index_of(&[("/s.R", &text)]);
    let start = offset_of(&text, "wmean(1)");
    let hover = index.hover("/s.R", start + 1).unwrap();
    assert_eq!((hover.range.start, hover.range.end), (start, start + 5));
}

#[test]
fn offsets_out_of_range_or_inside_characters_do_not_panic() {
    let text = "#' Doc\nf <- function(x) NULL\nf(\"😀\", 1)\n";
    let index = index_of(&[("/s.R", text)]);
    let len = text.encode_utf16().count() as u32;
    for offset in (0..=len + 3).chain([u32::MAX]) {
        let _ = index.hover("/s.R", offset);
        let _ = index.signature_help("/s.R", offset);
    }
    assert!(index.hover("/missing.R", 0).is_none());
    assert!(index.signature_help("/missing.R", 0).is_none());
}

#[test]
fn empty_and_unparseable_files() {
    let mut index = Index::new();
    index.update_file("/e.R", "");
    index.update_file("/w.R", "   \n\n");
    index.update_file("/g.R", "}}}) ((( ''' \"");
    assert!(index.hover("/e.R", 0).is_none());
    assert!(index.signature_help("/g.R", 5).is_none());
    assert!(index.documented_functions().is_empty());
}

#[test]
fn hover_uses_the_r_help_layout() {
    let text = "#' Combine things\n#'\n#' Joins them.\n#'\n#' Longer details.\n#'\n#' @param x,y Shared doc.\n#' @param z Own doc.\n#' @returns A thing.\n#' @section Warning:\n#' Be careful.\n#' @seealso [other()]\n#' @examples\n#' comb(1, 2, 3)\ncomb <- function(x, y, z) NULL\n";
    let index = index_of(&[("/dir/s.R", text)]);
    let hover = index.hover("/dir/s.R", offset_of(text, "comb <-")).unwrap();
    let expected = "_comb {s.R}_\n\n## Combine things\n\n------\n\n### Description\n\nJoins them.\n\n### Usage\n\n```r\ncomb(x, y, z)\n```\n\n### Arguments\n\n|     |     |\n| --- | --- |\n| `x`, `y` | Shared doc. |\n| `z` | Own doc. |\n\n### Details\n\nLonger details.\n\n### Value\n\nA thing.\n\n### Warning\n\nBe careful.\n\n### See Also\n\n`other()`\n\n### Examples\n\n```r\ncomb(1, 2, 3)\n```";
    assert_eq!(hover.markdown.trim_end(), expected);
    assert_eq!(
        index.documentation("comb", None).unwrap().trim_end(),
        expected
    );
}

#[test]
fn undocumented_and_unknown_callees_return_none() {
    let text =
        "#' Doc\nf <- function(x) NULL\ng <- function(x) NULL\nf(1)\ng(1)\nbase::f(1)\nnope(1)\n";
    let index = index_of(&[("/s.R", text)]);
    for needle in ["g(1)", "base::f(1)", "nope(1)"] {
        let offset = offset_of(text, needle) + needle.len() as u32 - 3;
        assert!(index.hover("/s.R", offset).is_none(), "{needle}");
        assert!(index.signature_help("/s.R", offset).is_none(), "{needle}");
    }
}

#[test]
fn first_definition_in_a_file_wins() {
    let text = "#' First\nf <- function(x) NULL\n\n#' Second\nf <- function(x) NULL\nf(1)\n";
    let index = index_of(&[("/s.R", text)]);
    let hover = index.hover("/s.R", offset_of(text, "f(1)") + 1).unwrap();
    assert!(hover.markdown.contains("First"));
    assert!(!hover.markdown.contains("Second"));
}

#[test]
fn right_assignment_definitions_resolve() {
    let text = "#' Doc\n(function(x) x) -> f\nf(1)\n";
    let index = index_of(&[("/s.R", text)]);
    let hover = index.hover("/s.R", offset_of(text, "f(1)")).unwrap();
    assert_eq!(hover.name, "f");
    assert_eq!(index.documented_functions()[0].name, "f");
}

#[test]
fn documented_functions_list_every_documented_definition() {
    let index = index_of(&[
        (
            "/b.R",
            "#' B fn\nb <- function() NULL\nplain <- function() NULL\n",
        ),
        ("/a.R", "#' A fn\na <- function() NULL\n"),
    ]);
    let mut got: Vec<_> = index
        .documented_functions()
        .into_iter()
        .map(|f| (f.name, f.path, f.title))
        .collect();
    got.sort();
    assert_eq!(
        got,
        [
            (
                "a".to_string(),
                "/a.R".to_string(),
                Some("A fn".to_string())
            ),
            (
                "b".to_string(),
                "/b.R".to_string(),
                Some("B fn".to_string())
            ),
        ]
    );
}

#[test]
fn identical_update_is_a_no_op() {
    let mut index = index_of(&[("/s.R", WMEAN)]);
    index.update_file("/s.R", WMEAN);
    assert_eq!(index.documented_functions().len(), 1);
}

#[test]
fn local_inherit_params_across_files() {
    let child = "#' Child\n#' @inheritParams base\nchild <- function(data) NULL\nchild(1)\n";
    let index = index_of(&[
        (
            "/base.R",
            "#' Base\n#' @param data The data.\nbase <- function(data) NULL\n",
        ),
        ("/child.R", child),
    ]);
    let sig = index
        .signature_help("/child.R", offset_of(child, "1)") + 1)
        .unwrap();
    assert_eq!(sig.parameters[0].documentation, "The data.");
}

#[test]
fn signature_help_shape_and_json() {
    let text = format!("{WMEAN}wmean(1, )\n");
    let index = index_of(&[("/s.R", &text)]);
    let sig = index
        .signature_help("/s.R", offset_of(&text, ")\n"))
        .unwrap();
    assert_eq!(sig.name, "wmean");
    assert_eq!(sig.label, "wmean(x, w = 1)");
    assert_eq!(sig.parameters.len(), 2);
    assert_eq!(sig.parameters[0].label, [6, 7]);
    assert_eq!(sig.parameters[1].label, [9, 14]);
    assert_eq!(sig.parameters[0].documentation, "Values.");
    assert_eq!(sig.parameters[1].documentation, "");
    assert_eq!(sig.active_parameter, Some(1));
    assert_eq!(sig.documentation, "**Weighted mean**");

    let json = serde_json::to_value(&sig).unwrap();
    assert_eq!(json["activeParameter"], 1);
    assert_eq!(json["parameters"][0]["label"], serde_json::json!([6, 7]));
    assert_eq!(json["source"], "static");

    let hover = serde_json::to_value(
        index
            .hover("/s.R", offset_of(&text, "wmean(1") + 1)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(hover["kind"], "call");
    assert!(hover["range"]["start"].is_u64());

    let summary = serde_json::to_value(index.documented_functions()).unwrap();
    assert_eq!(summary[0]["title"], "Weighted mean");
    assert_eq!(summary[0]["path"], "/s.R");
}

#[test]
fn active_parameter_is_null_when_unmatched() {
    let text = "#' Doc\nf <- function(x) NULL\nf(1, 2, )\n";
    let index = index_of(&[("/s.R", text)]);
    let sig = index
        .signature_help("/s.R", offset_of(text, ")\n"))
        .unwrap();
    assert_eq!(sig.active_parameter, None);
    assert_eq!(
        serde_json::to_value(&sig).unwrap()["activeParameter"],
        serde_json::Value::Null
    );
}

#[test]
fn documentation_of_unknown_or_undocumented_is_none() {
    let index = index_of(&[("/s.R", "f <- function() NULL\n")]);
    assert!(index.documentation("f", None).is_none());
    assert!(index.documentation("nope", None).is_none());
}

mod manifest {
    use super::*;

    fn manifest_for(path: &str, text: &str, topic: &str) -> String {
        format!(
            r#"{{"version":1,"files":[{{"path":"{path}","content_hash":"{}","topics":[{topic}]}}]}}"#,
            content_hash(text)
        )
    }

    const TOPIC: &str = r#"{"name":"wmean","aliases":["wmean","wm"],"title":"Manifest title",
        "description_md":"Manifest [wmean()] description.","details_md":"Deep details.",
        "params":[{"name":"x","md":"Manifest x."},{"name":"w","md":"Manifest w."}],
        "returns_md":"Manifest returns.","sections":[{"title":"Notes","md":"A note."}],
        "examples":"wmean(1)","inherited_from":["dplyr::mutate"],"future_field":1}"#;

    #[test]
    fn matching_hash_uses_the_manifest() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        let hover = index
            .hover("/s.R", offset_of(WMEAN, "wmean <-") + 1)
            .unwrap();
        assert_eq!(hover.source, DocSource::Manifest);
        assert!(
            hover
                .markdown
                .contains("### Usage\n\n```r\nwmean(x, w = 1)\n```"),
            "signature stays static"
        );
        assert!(hover.markdown.contains("## Manifest title"));
        assert!(
            hover.markdown.contains("Manifest `wmean()` description."),
            "links go through the same path"
        );
        assert!(hover.markdown.contains("| `w` | Manifest w. |"));
        assert!(hover.markdown.contains("### Notes\n\nA note."));
        assert!(!hover.markdown.contains("Weighted mean"));

        let page = index.documentation("wmean", None).unwrap();
        assert!(page.contains("### Details\n\nDeep details."));
        assert!(page.contains("```r\nwmean(1)\n```"));
    }

    #[test]
    fn signature_help_uses_the_manifest() {
        let text = format!("{WMEAN}wmean(1, )\n");
        let mut index = index_of(&[("/s.R", &text)]);
        index
            .load_manifest(&manifest_for("/s.R", &text, TOPIC))
            .unwrap();
        let sig = index
            .signature_help("/s.R", offset_of(&text, ")\n"))
            .unwrap();
        assert_eq!(sig.source, DocSource::Manifest);
        assert_eq!(sig.parameters[1].documentation, "Manifest w.");
        assert_eq!(sig.label, "wmean(x, w = 1)");
    }

    #[test]
    fn hash_mismatch_falls_back_to_static() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", "other text", TOPIC))
            .unwrap();
        let hover = index.hover("/s.R", offset_of(WMEAN, "wmean <-")).unwrap();
        assert_eq!(hover.source, DocSource::Static);
        assert!(hover.markdown.contains("Weighted mean"));
    }

    #[test]
    fn editing_after_the_manifest_was_built_falls_back() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        let edited = WMEAN.replace("Weighted mean", "Edited mean");
        index.update_file("/s.R", &edited);
        let hover = index.hover("/s.R", offset_of(&edited, "wmean <-")).unwrap();
        assert_eq!(hover.source, DocSource::Static);
        assert!(hover.markdown.contains("Edited mean"));
        index.update_file("/s.R", WMEAN);
        let hover = index.hover("/s.R", offset_of(WMEAN, "wmean <-")).unwrap();
        assert_eq!(
            hover.source,
            DocSource::Manifest,
            "reverting the edit matches the hash again"
        );
    }

    #[test]
    fn aliases_resolve_to_the_topic() {
        let text = "wm <- function(x) NULL\n";
        let mut index = index_of(&[("/s.R", text)]);
        index
            .load_manifest(&manifest_for("/s.R", text, TOPIC))
            .unwrap();
        let hover = index.hover("/s.R", 1).unwrap();
        assert_eq!(hover.source, DocSource::Manifest);
        assert!(hover.markdown.starts_with("_wm {s.R}_"));
    }

    #[test]
    fn undocumented_function_with_a_topic_counts_as_documented() {
        let text = "wmean <- function(x, w = 1) NULL\n";
        let mut index = index_of(&[("/s.R", text)]);
        assert!(index.documented_functions().is_empty());
        index
            .load_manifest(&manifest_for("/s.R", text, TOPIC))
            .unwrap();
        let docs = index.documented_functions();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].title.as_deref(), Some("Manifest title"));
        index.clear_manifest();
        assert!(index.documented_functions().is_empty());
    }

    #[test]
    fn manifest_for_another_file_does_not_apply() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/other.R", WMEAN, TOPIC))
            .unwrap();
        assert_eq!(
            index
                .hover("/s.R", offset_of(WMEAN, "wmean <-"))
                .unwrap()
                .source,
            DocSource::Static
        );
    }

    #[test]
    fn loading_replaces_the_previous_manifest() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        index.load_manifest(r#"{"version":1,"files":[]}"#).unwrap();
        assert_eq!(
            index
                .hover("/s.R", offset_of(WMEAN, "wmean <-"))
                .unwrap()
                .source,
            DocSource::Static
        );
    }

    #[test]
    fn invalid_manifests_are_rejected_and_keep_the_previous_one() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        assert!(index.load_manifest(r#"{"version":2,"files":[]}"#).is_err());
        assert!(index.load_manifest("not json").is_err());
        assert!(index.load_manifest("{}").is_err());
        assert!(
            index
                .load_manifest(r#"{"version":1,"files":{"a":1}}"#)
                .is_err()
        );
        assert_eq!(
            index
                .hover("/s.R", offset_of(WMEAN, "wmean <-"))
                .unwrap()
                .source,
            DocSource::Manifest
        );
    }

    #[test]
    fn unknown_fields_are_ignored_and_nulls_allowed() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        let topic = r#"{"name":"wmean","title":"T","description_md":null,"details_md":null,"params":null,"x":{"y":1}}"#;
        let json =
            manifest_for("/s.R", WMEAN, topic).replace("\"files\"", "\"extra\":[1],\"files\"");
        index.load_manifest(&json).unwrap();
        let hover = index.hover("/s.R", offset_of(WMEAN, "wmean <-")).unwrap();
        assert!(hover.markdown.contains("## T"));
    }

    #[test]
    fn manifest_params_follow_static_formal_order() {
        let topic = r#"{"name":"wmean","params":[{"name":"w","md":"W."},{"name":"x","md":"X."},{"name":"gone","md":"G."}]}"#;
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, topic))
            .unwrap();
        let md = index
            .hover("/s.R", offset_of(WMEAN, "wmean <-"))
            .unwrap()
            .markdown;
        assert!(md.contains("| `x` | X. |\n| `w` | W. |"), "{md}");
        assert!(!md.contains("gone"));
    }

    #[test]
    fn missing_files_key_is_an_empty_manifest() {
        let mut index = index_of(&[("/s.R", WMEAN)]);
        index.load_manifest(r#"{"version":1}"#).unwrap();
        assert_eq!(
            index
                .hover("/s.R", offset_of(WMEAN, "wmean <-"))
                .unwrap()
                .source,
            DocSource::Static
        );
    }

    #[test]
    fn manifest_takes_over_per_file_only() {
        let other = "#' Other static\nother <- function() NULL\n";
        let mut index = index_of(&[("/s.R", WMEAN), ("/o.R", other)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        assert_eq!(
            index
                .hover("/o.R", offset_of(other, "other <-"))
                .unwrap()
                .source,
            DocSource::Static
        );
    }

    #[test]
    fn manifest_serves_hover_on_calls_in_other_files() {
        let user = "wmean(1, )\n";
        let mut index = index_of(&[("/s.R", WMEAN), ("/u.R", user)]);
        index
            .load_manifest(&manifest_for("/s.R", WMEAN, TOPIC))
            .unwrap();
        let hover = index.hover("/u.R", 1).unwrap();
        assert_eq!(
            (hover.source, hover.kind),
            (DocSource::Manifest, HoverKind::Call)
        );
        assert!(hover.markdown.contains("## Manifest title"));
    }
}

mod fingerprints {
    use super::*;

    fn doc_hash(text: &str) -> String {
        index_of(&[("/s.R", text)]).fingerprints()[0]
            .doc_hash
            .clone()
    }

    const BASE: &str = "#' Title\n#' @param x Values.\nf <- function(x, w = 1) {\n  x + w\n}\n";

    #[test]
    fn fingerprints_are_sorted_by_path_and_carry_both_hashes() {
        let index = index_of(&[("/b.R", "b <- 1\n"), ("/a.R", BASE)]);
        let prints = index.fingerprints();
        assert_eq!(prints[0].path, "/a.R");
        assert_eq!(prints[1].path, "/b.R");
        assert_eq!(prints[0].content_hash, content_hash(BASE));
        assert_eq!(prints[0].doc_hash.len(), 16);
        assert_eq!(
            serde_json::to_value(&prints[0]).unwrap()["docHash"],
            prints[0].doc_hash.as_str()
        );
    }

    #[test]
    fn body_edits_leave_the_doc_hash_alone() {
        let edited = BASE.replace("x + w", "x * w + 1  # changed");
        assert_eq!(doc_hash(BASE), doc_hash(&edited));
        assert_ne!(content_hash(BASE), content_hash(&edited));
    }

    #[test]
    fn plain_code_and_comments_between_statements_do_not_matter() {
        let edited = format!("{BASE}x <- 1\n# note\nprint(x)\n");
        assert_eq!(doc_hash(BASE), doc_hash(&edited));
    }

    #[test]
    fn doc_relevant_edits_change_it() {
        let base = doc_hash(BASE);
        for edited in [
            BASE.replace("Values.", "Other values."),
            BASE.replace("w = 1", "w = 2"),
            BASE.replace("function(x, w = 1)", "function(x,\n  w = 1)"),
            BASE.replace("f <- ", "g <- "),
            BASE.replace("#' Title\n", "#' Title\n\n"),
            format!("#' More\n{BASE}"),
        ] {
            assert_ne!(base, doc_hash(&edited), "{edited}");
        }
    }

    #[test]
    fn non_function_statements_after_a_block_count() {
        let a = "#' Data\n#' @format A table.\ndata_x <- data.frame(a = 1)\n";
        let b = "#' Data\n#' @format A table.\ndata_x <- data.frame(a = 2)\n";
        assert_ne!(doc_hash(a), doc_hash(b));
        let c = "#' Doc\n\"_PACKAGE\"\n";
        let d = "#' Doc\nNULL\n";
        assert_ne!(doc_hash(c), doc_hash(d));
    }

    #[test]
    fn encoding_is_unambiguous() {
        assert_ne!(
            doc_hash("f <- function(a) 1\ng <- function(b) 1\n"),
            doc_hash("f <- function(a) 1\ng <- function(b, a) 1\n")
        );
        assert_ne!(doc_hash("#' a\n#' b\nNULL\n"), doc_hash("#' a b\nNULL\n"));
    }

    #[test]
    fn manifest_applies_when_only_the_body_changed() {
        let built_from =
            "#' Weighted mean\n#'\n#' @param x Values.\nwmean <- function(x, w = 1) NULL\n";
        let edited = built_from.replace("NULL", "{ x }");
        let doc = doc_hash(built_from);
        let json = format!(
            r#"{{"version":1,"files":[{{"path":"/s.R","content_hash":"{doc}","topics":[{{"name":"wmean","title":"From roxygen2"}}]}}]}}"#
        );
        let mut index = index_of(&[("/s.R", &edited)]);
        index.load_manifest(&json).unwrap();
        let hover = index
            .hover("/s.R", offset_of(&edited, "wmean <-") + 1)
            .unwrap();
        assert_eq!(hover.source, DocSource::Manifest);
        assert!(hover.markdown.contains("From roxygen2"));

        index.update_file("/s.R", &edited.replace("Values.", "Changed."));
        let hover = index
            .hover("/s.R", offset_of(&edited, "wmean <-") + 1)
            .unwrap();
        assert_eq!(hover.source, DocSource::Static);
    }
}

mod reverse_maps {
    use super::*;

    const CALLER: &str = "#' In b\ng <- function() f()\n";

    fn hover_f(index: &Index) -> Option<rozone_core::Hover> {
        index.hover("/b.R", offset_of(CALLER, "f()") + 1)
    }

    #[test]
    fn definitions_moving_between_files_stay_resolvable() {
        let mut index = index_of(&[("/a.R", "#' In a\nf <- function() 1\n"), ("/b.R", CALLER)]);
        assert!(hover_f(&index).unwrap().markdown.contains("In a"));
        index.update_file("/a.R", "#' Renamed\nh <- function() 1\n");
        assert!(hover_f(&index).is_none());
        index.update_file("/c.R", "#' In c\nf <- function() 1\n");
        assert!(hover_f(&index).unwrap().markdown.contains("In c"));
        index.remove_file("/c.R");
        assert!(hover_f(&index).is_none());
    }

    #[test]
    fn rdname_members_follow_updates() {
        let mut index = index_of(&[
            ("/a.R", "#' Main\n#' @param x X.\nf <- function(x) 1\n"),
            ("/b.R", "#' @rdname f\ng <- function(x) 2\n"),
        ]);
        assert!(index.documentation("f", None).unwrap().contains("g()"));
        index.update_file("/b.R", "g <- function(x) 2\n");
        assert!(!index.documentation("f", None).unwrap().contains("g()"));
    }

    #[test]
    fn diamond_inheritance_resolves_without_blowup() {
        let mut text = String::from("#' Root\n#' @param x Root x.\nl0 <- function(x) 1\n");
        for i in 1..=40 {
            let prev = i - 1;
            text.push_str(&format!(
                "#' Level {i}\n#' @inheritParams l{prev}\n#' @inheritParams l{prev}\nl{i} <- function(x) 1\n"
            ));
        }
        let index = index_of(&[("/d.R", &text)]);
        let page = index.documentation("l40", None).unwrap();
        assert!(page.contains("Level 40"));
    }
}

mod tree_cache {
    use super::*;

    const FILLERS: usize = 40;

    fn evict(index: &mut Index) {
        for i in 0..FILLERS {
            index.update_file(
                &format!("/zz{i:02}.R"),
                &format!("#' F{i}\nfiller{i} <- function(x) NULL\n"),
            );
        }
    }

    #[test]
    fn hover_and_signature_help_match_after_eviction() {
        let child = "#' Child\n#' @inheritParams base\nchild <- function(data) NULL\nchild(1)\n";
        let base = "#' Base\n#' @param data The data.\nbase <- function(data) NULL\n";
        let mut index = index_of(&[("/base.R", base), ("/child.R", child)]);
        let hover_at = offset_of(child, "child(1)") + 1;
        let sig_at = offset_of(child, "1)") + 1;
        let hover_before = index.hover("/child.R", hover_at);
        let sig_before = index.signature_help("/child.R", sig_at);
        let docs_before = index.documentation("child", Some("/child.R"));
        assert!(hover_before.is_some());

        evict(&mut index);

        assert_eq!(index.hover("/child.R", hover_at), hover_before);
        assert_eq!(index.signature_help("/child.R", sig_at), sig_before);
        assert_eq!(index.documentation("child", Some("/child.R")), docs_before);
        assert_eq!(
            sig_before.unwrap().parameters[0].documentation,
            "The data."
        );
    }

    #[test]
    fn fingerprints_and_listing_do_not_need_trees() {
        let mut index = index_of(&[("/a.R", WMEAN)]);
        let before = index.fingerprints();
        let listed = index.documented_functions();
        evict(&mut index);
        let after = index.fingerprints();
        assert_eq!(after.iter().find(|f| f.path == "/a.R"), before.first());
        assert_eq!(index.documented_functions()[0], listed[0]);
    }

    #[test]
    fn edits_after_eviction_replace_the_tree() {
        let mut index = index_of(&[("/a.R", WMEAN)]);
        evict(&mut index);
        let edited = format!("{WMEAN}wmean(1)\n");
        index.update_file("/a.R", &edited);
        evict(&mut index);
        let hover = index.hover("/a.R", offset_of(&edited, "wmean(1)") + 1);
        assert_eq!(hover.unwrap().kind, HoverKind::Call);
        index.remove_file("/a.R");
        assert!(index.hover("/a.R", 0).is_none());
    }
}
