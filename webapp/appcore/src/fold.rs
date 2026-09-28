//! Folding text for SEARCH and SORT: case and accents dropped, so "beyonce"
//! finds "Beyoncé", "Éric" sorts with the E's and not after "Zazie", and
//! "don't" finds "Don’t".
//!
//! What the lists did before was `toLowerCase()` and a comparison of UTF-16
//! code units, which is case-folding and nothing else: every accented capital
//! sorted after the whole alphabet (É is U+00C9, z is U+007A) and a search
//! typed without accents missed every title that had them — in a French
//! library, that is most of it.
//!
//! This is not a full collation (no ICU tables in a few kilobytes of
//! WebAssembly, and none needed): the Latin letters a music library actually
//! holds are mapped to their base letters by the table below, ligatures are
//! spelled out (œ -> oe, ß -> ss), combining marks are dropped (text that
//! arrives decomposed), typographic quotes and dashes become their plain
//! forms, and every other character is lowercased by Unicode's own rules.

/// The base letters for U+00C0..U+017F, one or two ASCII bytes each (a
/// second byte of 0 means one). Latin-1 Supplement and Latin Extended-A:
/// French, German, Spanish, Portuguese, the Nordic languages, Polish, Czech,
/// Hungarian, Turkish, Romanian, the Baltic languages.
const LATIN: [[u8; 2]; 192] = {
    const fn one(c: u8) -> [u8; 2] {
        [c, 0]
    }
    let mut t = [[0u8; 2]; 192];
    // U+00C0..U+00FF
    let a = b"aaaaaa";
    let mut i = 0;
    while i < 6 {
        t[i] = one(a[i]); // À Á Â Ã Ä Å
        i += 1;
    }
    t[0x06] = [b'a', b'e']; // Æ
    t[0x07] = one(b'c'); // Ç
    t[0x08] = one(b'e');
    t[0x09] = one(b'e');
    t[0x0a] = one(b'e');
    t[0x0b] = one(b'e'); // È É Ê Ë
    t[0x0c] = one(b'i');
    t[0x0d] = one(b'i');
    t[0x0e] = one(b'i');
    t[0x0f] = one(b'i'); // Ì Í Î Ï
    t[0x10] = one(b'd'); // Ð
    t[0x11] = one(b'n'); // Ñ
    t[0x12] = one(b'o');
    t[0x13] = one(b'o');
    t[0x14] = one(b'o');
    t[0x15] = one(b'o');
    t[0x16] = one(b'o'); // Ò Ó Ô Õ Ö
    t[0x17] = one(b'x'); // × (multiplication sign: "x" is what people type)
    t[0x18] = one(b'o'); // Ø
    t[0x19] = one(b'u');
    t[0x1a] = one(b'u');
    t[0x1b] = one(b'u');
    t[0x1c] = one(b'u'); // Ù Ú Û Ü
    t[0x1d] = one(b'y'); // Ý
    t[0x1e] = [b't', b'h']; // Þ
    t[0x1f] = [b's', b's']; // ß
    // The lowercase half mirrors the uppercase one.
    let mut k = 0;
    while k < 0x20 {
        t[0x20 + k] = t[k];
        k += 1;
    }
    t[0x37] = [b'/', 0]; // ÷
    t[0x3e] = [b't', b'h']; // þ
    t[0x3f] = one(b'y'); // ÿ
    // U+0100..U+017F: mostly pairs (capital, small) of one base letter.
    let ext = b"aaaaaaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiijjjjkkkllllllllllnnnnnnnnnoooooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs";
    let mut j = 0;
    while j < 128 {
        t[0x40 + j] = one(ext[j]);
        j += 1;
    }
    t[0x40 + 0x32] = [b'i', b'j']; // Ĳ
    t[0x40 + 0x33] = [b'i', b'j']; // ĳ
    t[0x40 + 0x49] = one(b'n'); // ŉ
    t[0x40 + 0x52] = [b'o', b'e']; // Œ
    t[0x40 + 0x53] = [b'o', b'e']; // œ
    t
};

/// Append the folded form of `c` to `out`.
#[inline]
fn fold_char(c: char, out: &mut Vec<u8>) {
    let u = c as u32;
    if u < 0x80 {
        let b = u as u8;
        out.push(if b.is_ascii_uppercase() { b + 32 } else { b });
        return;
    }
    if (0xC0..0x180).contains(&u) {
        let m = LATIN[(u - 0xC0) as usize];
        out.push(m[0]);
        if m[1] != 0 {
            out.push(m[1]);
        }
        return;
    }
    match u {
        // Combining diacritical marks: text that arrives decomposed (NFD)
        // carries its accents as separate characters.
        0x0300..=0x036F => {}
        // Typographic quotes and dashes, as people type them.
        0x2018 | 0x2019 | 0x201B | 0x2032 | 0x00B4 => out.push(b'\''),
        0x201C | 0x201D | 0x201F | 0x2033 => out.push(b'"'),
        0x2010..=0x2015 | 0x2212 => out.push(b'-'),
        // No-break and other spaces: a plain space.
        0x00A0 | 0x2000..=0x200A | 0x202F | 0x205F | 0x3000 => out.push(b' '),
        _ => {
            for l in c.to_lowercase() {
                let lu = l as u32;
                if (0x0300..=0x036F).contains(&lu) {
                    continue;
                }
                let mut b = [0u8; 4];
                out.extend_from_slice(l.encode_utf8(&mut b).as_bytes());
            }
        }
    }
}

/// Fold UTF-8 `src` into `out` (appended). Invalid UTF-8 is replaced
/// character by character with U+FFFD, like a decoder would.
pub fn fold_into(src: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < src.len() {
        let b = src[i];
        if b < 0x80 {
            out.push(if b.is_ascii_uppercase() { b + 32 } else { b });
            i += 1;
            continue;
        }
        let (c, n) = decode(&src[i..]);
        fold_char(c, out);
        i += n;
    }
}

/// One UTF-8 character at the start of `s` (non-empty, first byte >= 0x80).
#[inline]
fn decode(s: &[u8]) -> (char, usize) {
    let b0 = s[0] as u32;
    let (n, init) = if b0 & 0xE0 == 0xC0 {
        (2, b0 & 0x1F)
    } else if b0 & 0xF0 == 0xE0 {
        (3, b0 & 0x0F)
    } else if b0 & 0xF8 == 0xF0 {
        (4, b0 & 0x07)
    } else {
        return ('\u{FFFD}', 1);
    };
    if s.len() < n {
        return ('\u{FFFD}', 1);
    }
    let mut u = init;
    for k in 1..n {
        let b = s[k] as u32;
        if b & 0xC0 != 0x80 {
            return ('\u{FFFD}', 1);
        }
        u = (u << 6) | (b & 0x3F);
    }
    match char::from_u32(u) {
        Some(c) => (c, n),
        None => ('\u{FFFD}', n),
    }
}

/// Whether `needle` occurs in `hay`. Byte-wise on folded UTF-8, which is
/// exact: a folded needle can only match at a character boundary of a folded
/// haystack, since UTF-8 is self-synchronising.
#[inline]
pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    let n = needle.len();
    if n == 0 {
        return true;
    }
    if n > hay.len() {
        return false;
    }
    let first = needle[0];
    let last = hay.len() - n;
    let mut i = 0;
    while i <= last {
        // The first byte decides almost every position: skip to the next one.
        match hay[i..=last].iter().position(|&b| b == first) {
            None => return false,
            Some(k) => i += k,
        }
        if &hay[i..i + n] == needle {
            return true;
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(s: &str) -> String {
        let mut v = Vec::new();
        fold_into(s.as_bytes(), &mut v);
        String::from_utf8(v).unwrap()
    }

    #[test]
    fn folds_the_letters_a_library_holds() {
        assert_eq!(f("Beyoncé"), "beyonce");
        assert_eq!(f("ÉRIC Serra"), "eric serra");
        assert_eq!(f("Œuvre"), "oeuvre");
        assert_eq!(f("Straße"), "strasse");
        assert_eq!(f("Sigur Rós"), "sigur ros");
        assert_eq!(f("Mötley Crüe"), "motley crue");
        assert_eq!(f("Łódź"), "lodz");
        assert_eq!(f("Ævar Þór"), "aevar thor");
        assert_eq!(f("Dvořák"), "dvorak");
        assert_eq!(f("Don’t Stop"), "don't stop");
        assert_eq!(f("Café\u{0301}"), "cafe"); // a stray combining accent
        assert_eq!(f("Cafe\u{0301}"), "cafe"); // decomposed
        assert_eq!(f("Моя"), "моя");
        assert_eq!(f("ΑΒΓ"), "αβγ");
        assert_eq!(f("Ñandú"), "nandu");
        assert_eq!(f("İstanbul"), "istanbul");
    }

    #[test]
    fn every_latin_entry_is_a_letter_or_deliberate() {
        for (k, m) in LATIN.iter().enumerate() {
            assert!(m[0] != 0, "U+{:04X} has no mapping", 0xC0 + k);
        }
    }

    #[test]
    fn finds_what_it_should() {
        assert!(contains(b"hello world", b"o w"));
        assert!(contains(b"abc", b""));
        assert!(!contains(b"abc", b"abcd"));
        assert!(contains(b"aaab", b"aab"));
        assert!(!contains(b"aaab", b"aac"));
    }
}
