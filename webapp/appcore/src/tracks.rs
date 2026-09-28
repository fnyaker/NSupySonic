//! THE TRACK LISTS' INDEX: search and sort for a playlist, the favourites,
//! the downloads — lists of thousands of rows filtered on every keystroke.
//!
//! What the lists did before, per KEYSTROKE: lowercase the title, every
//! credited name and the album of every track (three to five fresh strings per
//! row, 12 000+ for a 4 000-track favourites page), and for a sort, lowercase
//! both keys again inside the comparator — O(n log n) string allocations,
//! ~100 000 of them for the same page, on the main thread while the person
//! types. And the answer was wrong for a French library: a code-unit
//! comparison sorts every accented capital after "z", and a search typed
//! without accents misses every title that has them.
//!
//! Here the work is done ONCE per list: every field is folded (fold.rs: case
//! and accents dropped, ligatures spelled out) into one contiguous buffer,
//! and each sort order is computed the first time it is asked for and kept.
//! A keystroke is then one pass over the folded bytes in the order already
//! computed, writing indices into a buffer the page reads in place.

use crate::fold::{contains, fold_into};

/// Fields per track in the page's input, separated by U+001F; tracks
/// separated by U+001E: title, the primary artist (the ARTIST sort key),
/// every credited name (what the search matches), the album.
pub const FIELDS: usize = 4;
const UNIT_SEP: u8 = 0x1F;
const RECORD_SEP: u8 = 0x1E;

/// The sorts, as the page names them (TrackBrowser.svelte's SORTS).
pub const SORT_DEFAULT: u32 = 0;
pub const SORT_TITLE: u32 = 1;
pub const SORT_ARTIST: u32 = 2;
pub const SORT_ALBUM: u32 = 3;
pub const SORT_DURATION: u32 = 4;
pub const SORT_ADDED: u32 = 5;
const SORTS: usize = 6;

#[derive(Clone, Copy, Default)]
struct Row {
    /// The folded haystack — title, US, every name, US, album — in `text`.
    hay: (u32, u32),
    /// The title and the album inside it, and the primary artist on its own.
    title: (u32, u32),
    album: (u32, u32),
    artist: (u32, u32),
}

pub struct TrackIndex {
    /// The page writes the list here (UTF-8) before `build`.
    pub input: Vec<u8>,
    /// ...and the numeric keys, two per track: duration, date added.
    pub nums: Vec<f64>,
    text: Vec<u8>,
    rows: Vec<Row>,
    /// One cached order per (sort, direction), built on first use.
    orders: Vec<Option<Vec<u32>>>,
    /// The page writes a query here (UTF-8) before `filter`.
    pub query: Vec<u8>,
    folded_query: Vec<u8>,
    /// What `filter` answered: indices into the list, in display order.
    pub out: Vec<u32>,
}

impl TrackIndex {
    pub fn new() -> TrackIndex {
        TrackIndex {
            input: Vec::new(),
            nums: Vec::new(),
            text: Vec::new(),
            rows: Vec::new(),
            orders: (0..SORTS * 2).map(|_| None).collect(),
            query: Vec::new(),
            folded_query: Vec::new(),
            out: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Room for `bytes` of input and `count` tracks' numbers.
    pub fn reserve(&mut self, bytes: usize, count: usize) {
        self.input.clear();
        self.input.resize(bytes, 0);
        self.nums.clear();
        self.nums.resize(count * 2, 0.0);
    }

    /// Index the first `used` bytes of `input` as `count` tracks.
    pub fn build(&mut self, used: usize, count: usize) {
        for o in self.orders.iter_mut() {
            *o = None;
        }
        self.rows.clear();
        self.text.clear();
        let used = used.min(self.input.len());
        let src = core::mem::take(&mut self.input);
        let mut fields: [&[u8]; FIELDS] = [&[]; FIELDS];
        let mut start = 0;
        let mut f = 0;
        let mut i = 0;
        while i <= used && self.rows.len() < count {
            let end_of_record = i == used || src[i] == RECORD_SEP;
            if end_of_record || src[i] == UNIT_SEP {
                if f < FIELDS {
                    fields[f] = &src[start..i];
                }
                f += 1;
                start = i + 1;
                if end_of_record {
                    self.push_row(&fields[..f.min(FIELDS)]);
                    fields = [&[]; FIELDS];
                    f = 0;
                }
            }
            i += 1;
        }
        // A list shorter than it said (an empty last record is still a row).
        while self.rows.len() < count {
            self.push_row(&[]);
        }
        // The input was sized for the worst case (three bytes per UTF-16 unit)
        // and is read exactly once: let it go rather than hold a megabyte per
        // list on screen. The next build asks for room again anyway.
        drop(src);
        self.nums.shrink_to_fit();
        self.text.shrink_to_fit();
        self.out.clear();
        self.out.reserve(count);
    }

    fn push_row(&mut self, fields: &[&[u8]]) {
        let field = |k: usize| -> &[u8] {
            if k < fields.len() {
                fields[k]
            } else {
                &[]
            }
        };
        let t = &mut self.text;
        let h0 = t.len() as u32;
        fold_into(field(0), t);
        let title = (h0, t.len() as u32);
        t.push(UNIT_SEP);
        fold_into(field(2), t);
        t.push(UNIT_SEP);
        let a0 = t.len() as u32;
        fold_into(field(3), t);
        let album = (a0, t.len() as u32);
        let hay = (h0, t.len() as u32);
        let r0 = t.len() as u32;
        fold_into(field(1), t);
        let artist = (r0, t.len() as u32);
        self.rows.push(Row { hay, title, album, artist });
    }

    #[inline]
    fn slice(&self, r: (u32, u32)) -> &[u8] {
        &self.text[r.0 as usize..r.1 as usize]
    }

    /// The order for (sort, dir): stable — equal keys keep the list's own
    /// order in BOTH directions, as the JavaScript's stable sort did — and the
    /// default order reversed for dir < 0.
    fn ensure_order(&mut self, sort: u32, desc: bool) -> usize {
        let sort = if (sort as usize) < SORTS { sort } else { SORT_DEFAULT };
        let slot = sort as usize * 2 + desc as usize;
        if self.orders[slot].is_none() {
            let n = self.rows.len() as u32;
            let mut o: Vec<u32> = if desc && sort == SORT_DEFAULT { (0..n).rev().collect() } else { (0..n).collect() };
            if sort != SORT_DEFAULT {
                let rows = &self.rows;
                let nums = &self.nums;
                let text = &self.text;
                let key = |i: u32| -> &[u8] {
                    let r = &rows[i as usize];
                    let s = match sort {
                        SORT_TITLE => r.title,
                        SORT_ARTIST => r.artist,
                        _ => r.album,
                    };
                    &text[s.0 as usize..s.1 as usize]
                };
                let num = |i: u32| -> f64 {
                    let k = if sort == SORT_DURATION { 0 } else { 1 };
                    let v = nums.get(i as usize * 2 + k).copied().unwrap_or(0.0);
                    if v.is_finite() {
                        v
                    } else {
                        0.0
                    }
                };
                // A stable sort, and ties broken by position explicitly too:
                // equal keys keep the list's order whatever the direction.
                o.sort_by(|&a, &b| {
                    let c = if sort == SORT_DURATION || sort == SORT_ADDED {
                        num(a).partial_cmp(&num(b)).unwrap_or(core::cmp::Ordering::Equal)
                    } else {
                        key(a).cmp(key(b))
                    };
                    let c = if desc { c.reverse() } else { c };
                    c.then(a.cmp(&b))
                });
            }
            self.orders[slot] = Some(o);
        }
        slot
    }

    /// The rows matching the first `qlen` bytes of `query` (UTF-8, already
    /// trimmed by the page), in (sort, dir) order, into `out`. Returns how
    /// many.
    pub fn filter(&mut self, sort: u32, desc: bool, qlen: usize) -> usize {
        let qlen = qlen.min(self.query.len());
        let mut fq = core::mem::take(&mut self.folded_query);
        fq.clear();
        fold_into(&self.query[..qlen], &mut fq);
        // The separator can never be part of what is searched for.
        fq.retain(|&b| b != UNIT_SEP && b != RECORD_SEP);
        let mut out = core::mem::take(&mut self.out);
        out.clear();
        let slot = self.ensure_order(sort, desc);
        if let Some(order) = self.orders[slot].as_deref() {
            if fq.is_empty() {
                out.extend_from_slice(order);
            } else {
                for &i in order {
                    let hay = self.slice(self.rows[i as usize].hay);
                    if contains(hay, &fq) {
                        out.push(i);
                    }
                }
            }
        }
        self.out = out;
        self.folded_query = fq;
        self.out.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(tracks: &[[&str; 4]], nums: &[f64]) -> TrackIndex {
        let mut s = String::new();
        for (k, t) in tracks.iter().enumerate() {
            if k > 0 {
                s.push('\u{1E}');
            }
            s.push_str(&t.join("\u{1F}"));
        }
        let mut ix = TrackIndex::new();
        ix.reserve(s.len(), tracks.len());
        ix.input[..s.len()].copy_from_slice(s.as_bytes());
        ix.nums[..nums.len()].copy_from_slice(nums);
        ix.build(s.len(), tracks.len());
        ix
    }

    fn q(ix: &mut TrackIndex, sort: u32, desc: bool, query: &str) -> Vec<u32> {
        ix.query.clear();
        ix.query.extend_from_slice(query.as_bytes());
        let n = ix.filter(sort, desc, query.len());
        ix.out[..n].to_vec()
    }

    const LIST: [[&str; 4]; 5] = [
        ["Zazie", "Zazie", "Zazie", "Zen"],
        ["Éric", "Beyoncé", "Beyoncé Jay-Z", "Lemonade"],
        ["abc", "Alpha", "Alpha", ""],
        ["Été", "Œil", "Œil", "Album"],
        ["abc", "Alpha", "Alpha Beta", "B"],
    ];

    #[test]
    fn accents_sort_with_their_letters() {
        let mut ix = index(&LIST, &[]);
        assert_eq!(q(&mut ix, SORT_TITLE, false, ""), vec![2, 4, 1, 3, 0]);
        // Ties keep the list's order in both directions.
        assert_eq!(q(&mut ix, SORT_TITLE, true, ""), vec![0, 3, 1, 2, 4]);
        assert_eq!(q(&mut ix, SORT_DEFAULT, true, ""), vec![4, 3, 2, 1, 0]);
    }

    #[test]
    fn a_search_without_accents_finds_them() {
        let mut ix = index(&LIST, &[]);
        assert_eq!(q(&mut ix, SORT_DEFAULT, false, "beyonce"), vec![1]);
        assert_eq!(q(&mut ix, SORT_DEFAULT, false, "OEIL"), vec![3]);
        assert_eq!(q(&mut ix, SORT_DEFAULT, false, "jay-z"), vec![1]);
        // A featured name is findable; the fields never run into each other.
        assert_eq!(q(&mut ix, SORT_DEFAULT, false, "beta"), vec![4]);
        assert_eq!(q(&mut ix, SORT_DEFAULT, false, "calpha"), Vec::<u32>::new());
    }

    #[test]
    fn numbers_sort_as_numbers() {
        let mut ix = index(&LIST, &[200.0, 5.0, 30.0, 1.0, 1000.0, 3.0, 30.0, 2.0, f64::NAN, 4.0]);
        assert_eq!(q(&mut ix, SORT_DURATION, false, ""), vec![4, 1, 3, 0, 2]);
        assert_eq!(q(&mut ix, SORT_ADDED, true, ""), vec![0, 4, 2, 3, 1]);
    }
}
