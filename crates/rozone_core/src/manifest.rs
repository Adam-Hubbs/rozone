//! The sidecar's roxygen2-built manifest (contracts §3).

use std::collections::HashMap;

use serde::{Deserialize, Deserializer};

use crate::ManifestError;

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestParam {
    pub name: String,
    #[serde(default, deserialize_with = "nullable")]
    pub md: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSection {
    pub title: String,
    #[serde(default, deserialize_with = "nullable")]
    pub md: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Topic {
    pub name: String,
    #[serde(default, deserialize_with = "nullable")]
    pub aliases: Vec<String>,
    pub title: Option<String>,
    pub description_md: Option<String>,
    pub details_md: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub params: Vec<ManifestParam>,
    pub returns_md: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub sections: Vec<ManifestSection>,
    pub examples: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub inherited_from: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawFile {
    path: String,
    content_hash: String,
    #[serde(default, deserialize_with = "nullable")]
    topics: Vec<Topic>,
}

#[derive(Debug, Clone, Deserialize)]
struct Raw {
    #[serde(default, deserialize_with = "nullable")]
    files: Vec<RawFile>,
}

fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone)]
pub struct ManifestFile {
    pub content_hash: String,
    topics: Vec<Topic>,
    by_name: HashMap<String, usize>,
}

impl ManifestFile {
    /// The topic documenting `name`, by topic name or alias.
    pub fn topic(&self, name: &str) -> Option<&Topic> {
        self.by_name.get(name).map(|&i| &self.topics[i])
    }
}

#[derive(Debug, Clone, Default)]
pub struct Manifest {
    files: HashMap<String, ManifestFile>,
}

impl Manifest {
    pub fn parse(json: &str) -> Result<Self, ManifestError> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| ManifestError(e.to_string()))?;
        match value.get("version").and_then(serde_json::Value::as_u64) {
            Some(1) => {}
            Some(other) => return Err(ManifestError(format!("unsupported version {other}"))),
            None => return Err(ManifestError("missing integer `version`".to_string())),
        }
        let raw: Raw = serde_json::from_value(value).map_err(|e| ManifestError(e.to_string()))?;
        let files = raw
            .files
            .into_iter()
            .map(|file| {
                let mut by_name = HashMap::new();
                for (i, topic) in file.topics.iter().enumerate() {
                    for name in std::iter::once(&topic.name).chain(&topic.aliases) {
                        by_name.entry(name.clone()).or_insert(i);
                    }
                }
                (
                    file.path,
                    ManifestFile {
                        content_hash: file.content_hash,
                        topics: file.topics,
                        by_name,
                    },
                )
            })
            .collect();
        Ok(Self { files })
    }

    /// The topic for `name` in `path`, only if the manifest was built from
    /// exactly the text that is indexed now (`current_hash`).
    pub fn topic_for(&self, path: &str, current_hash: &str, name: &str) -> Option<&Topic> {
        let file = self.files.get(path)?;
        if file.content_hash != current_hash {
            return None;
        }
        file.topic(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(json: &str) -> Result<Manifest, ManifestError> {
        Manifest::parse(json)
    }

    #[test]
    fn parses_the_contract_example() {
        let m = manifest(
            r#"{"version":1,"files":[{"path":"/a.R","content_hash":"abc","topics":[
                {"name":"wmean","aliases":["wmean","wm"],"title":"T","description_md":null,"details_md":null,
                 "params":[{"name":"x","md":"X"}],"returns_md":"R","sections":[{"title":"S","md":"s"}],
                 "examples":"wmean(1)","inherited_from":["dplyr::mutate"]}]}]}"#,
        )
        .unwrap();
        assert!(m.topic_for("/a.R", "abc", "wmean").is_some());
        assert!(
            m.topic_for("/a.R", "abc", "wm").is_some(),
            "aliases resolve"
        );
        assert!(
            m.topic_for("/a.R", "other", "wmean").is_none(),
            "hash mismatch"
        );
        assert!(
            m.topic_for("/b.R", "abc", "wmean").is_none(),
            "unknown path"
        );
        assert!(m.topic_for("/a.R", "abc", "nope").is_none());
    }

    #[test]
    fn rejects_other_versions_and_bad_json() {
        assert!(manifest(r#"{"version":2,"files":[]}"#).is_err());
        assert!(manifest(r#"{"files":[]}"#).is_err());
        assert!(manifest("not json").is_err());
        assert!(manifest(r#"{"version":1,"files":[{"path":1}]}"#).is_err());
    }

    #[test]
    fn unknown_fields_and_nulls_are_ignored() {
        let m = manifest(
            r#"{"version":1,"extra":true,"files":[{"path":"/a.R","content_hash":"h","future":1,
                "topics":[{"name":"f","aliases":null,"params":null,"sections":null,"wat":[]}]}]}"#,
        )
        .unwrap();
        assert!(m.topic_for("/a.R", "h", "f").is_some());
    }

    #[test]
    fn files_may_be_absent() {
        assert!(manifest(r#"{"version":1}"#).is_ok());
    }
}
