//! Core of schema-explorer: reads XML Schema (XSD) sets, and later JSON Schema,
//! into one indexed model for the viewer.
//!
//! Early development: the XSD reader is not implemented yet.

/// The version of this crate.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!super::version().is_empty());
    }
}
