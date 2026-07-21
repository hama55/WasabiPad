use crate::ziptext::Entry;

pub(crate) fn has_container_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

pub(crate) fn list(bytes: &[u8]) -> Option<Vec<String>> {
    crate::ziptext::list_names(bytes).or_else(|| crate::xlstext::list_sheet_names(bytes))
}

pub(crate) fn decode_one(bytes: &[u8], name: &str) -> Option<String> {
    crate::ziptext::decode_one(bytes, name).or_else(|| crate::xlstext::decode_one(bytes, name))
}

pub(crate) fn parse(bytes: &[u8]) -> Option<Vec<Entry>> {
    crate::ziptext::parse(bytes).or_else(|| crate::xlstext::parse(bytes))
}
