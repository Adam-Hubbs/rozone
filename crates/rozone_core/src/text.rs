//! UTF-16 <-> UTF-8 offset translation and the content hash (contracts §0).

/// A non-ASCII character: where it starts in both encodings and how wide it is.
#[derive(Debug, Clone, Copy)]
struct Wide {
    byte: u32,
    utf16: u32,
    len8: u8,
    len16: u8,
}

/// Offset translation for one text. ASCII text (the common case) stores nothing.
#[derive(Debug, Clone, Default)]
pub struct TextMap {
    wide: Vec<Wide>,
    len8: u32,
    len16: u32,
}

impl TextMap {
    pub fn new(text: &str) -> Self {
        let len8 = text.len() as u32;
        if text.is_ascii() {
            return Self {
                wide: Vec::new(),
                len8,
                len16: len8,
            };
        }
        let mut wide = Vec::new();
        let mut delta = 0u32;
        for (byte, ch) in text.char_indices() {
            if ch.is_ascii() {
                continue;
            }
            let (l8, l16) = (ch.len_utf8() as u32, ch.len_utf16() as u32);
            wide.push(Wide {
                byte: byte as u32,
                utf16: byte as u32 - delta,
                len8: l8 as u8,
                len16: l16 as u8,
            });
            delta += l8 - l16;
        }
        Self {
            wide,
            len8,
            len16: len8 - delta,
        }
    }

    pub fn len16(&self) -> u32 {
        self.len16
    }

    /// Byte offset to UTF-16 offset. A byte offset inside a character maps to
    /// the start of that character.
    pub fn to_utf16(&self, byte: u32) -> u32 {
        let byte = byte.min(self.len8);
        let idx = self.wide.partition_point(|w| w.byte < byte);
        let Some(w) = idx.checked_sub(1).map(|i| self.wide[i]) else {
            return byte;
        };
        let end8 = w.byte + u32::from(w.len8);
        if byte >= end8 {
            w.utf16 + u32::from(w.len16) + (byte - end8)
        } else {
            w.utf16
        }
    }

    /// UTF-16 offset to byte offset, clamped to the text. An offset in the
    /// middle of a surrogate pair maps to the start of the character.
    pub fn to_byte(&self, utf16: u32) -> u32 {
        let utf16 = utf16.min(self.len16);
        let idx = self.wide.partition_point(|w| w.utf16 < utf16);
        let Some(w) = idx.checked_sub(1).map(|i| self.wide[i]) else {
            return utf16;
        };
        let end16 = w.utf16 + u32::from(w.len16);
        if utf16 >= end16 {
            w.byte + u32::from(w.len8) + (utf16 - end16)
        } else {
            w.byte
        }
    }
}

/// FNV-1a 64-bit over the UTF-8 bytes, as 16 lowercase hex digits.
pub fn content_hash(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_known_values() {
        assert_eq!(content_hash(""), "cbf29ce484222325");
        assert_eq!(content_hash("a"), "af63dc4c8601ec8c");
        assert_eq!(content_hash("hello"), "a430d84680aabd0b");
    }

    #[test]
    fn ascii_is_identity() {
        let map = TextMap::new("hello");
        assert_eq!(map.to_utf16(3), 3);
        assert_eq!(map.to_byte(3), 3);
        assert_eq!(map.to_byte(99), 5);
        assert_eq!(map.to_utf16(99), 5);
    }

    #[test]
    fn mixed_widths() {
        // a(1/1) é(2/1) 😀(4/2) 中(3/1) b(1/1)
        let text = "aé😀中b";
        let map = TextMap::new(text);
        assert_eq!(map.len16(), 6);
        let expected = [(0, 0), (1, 1), (3, 2), (7, 4), (10, 5), (11, 6)];
        for (byte, utf16) in expected {
            assert_eq!(map.to_utf16(byte), utf16, "byte {byte}");
            assert_eq!(map.to_byte(utf16), byte, "utf16 {utf16}");
        }
    }

    #[test]
    fn offsets_inside_characters_snap_to_start() {
        let map = TextMap::new("a😀b");
        assert_eq!(map.to_byte(2), 1);
        assert_eq!(map.to_utf16(2), 1);
        assert_eq!(map.to_utf16(4), 1);
        assert_eq!(map.to_utf16(5), 3);
    }

    #[test]
    fn empty_text() {
        let map = TextMap::new("");
        assert_eq!(map.to_byte(5), 0);
        assert_eq!(map.to_utf16(5), 0);
    }
}
