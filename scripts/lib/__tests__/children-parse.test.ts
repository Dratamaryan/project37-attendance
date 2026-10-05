import { describe, it, expect } from 'vitest'
import {
  parseChildrenCell,
  parkReasonOf,
  isKnownPlace,
  isValidIsoDate,
  toIsoDate,
  KNOWN_CITIES,
  MONTHS,
  PARK_REASONS,
} from '../children-parse'

// ALL fixtures are invented ('Anak Satu', 'Anak Dua', 'Kenanga', ...). Never
// copy a name, date or phone from the real roster file into this suite.

describe('parseChildrenCell — entry separation', () => {
  it('single child, name - D MON YYYY', () => {
    const r = parseChildrenCell('Anak Satu - 5 Mei 2016')
    expect(r.parked).toBeNull()
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: '2016-05-05', notes: null }])
    expect(r.shape).toBe('entries=1;sep=single;date=word-dmy')
  })

  it('numbered list, 2 children on separate lines', () => {
    const r = parseChildrenCell('1. Anak Satu - 5 Mei 2016\n2. Anak Dua - 12 Agustus 2019')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2016-05-05', notes: null },
      { full_name: 'Anak Dua', birth_date: '2019-08-12', notes: null },
    ])
    expect(r.shape).toContain('sep=newline+numbered')
  })

  it('numbered list without a space after the marker', () => {
    const r = parseChildrenCell('1.Anak Satu 3 Juni 2017\n2.Anak Dua 4 Juli 2019')
    expect(r.children.map((c) => c.full_name)).toEqual(['Anak Satu', 'Anak Dua'])
  })

  it('comma-separated numbered entries on one line, D/M/YY dates', () => {
    const r = parseChildrenCell('1. Anak Satu - 05/06/16, 2. Anak Dua - 14/02/18')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2016-06-05', notes: null },
      { full_name: 'Anak Dua', birth_date: '2018-02-14', notes: null },
    ])
    expect(r.shape).toContain('comma')
  })

  it("'dan'-separated entries", () => {
    const r = parseChildrenCell('Anak Satu 03-04-2015 dan Anak Dua 09-07-2018')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2015-04-03', notes: null },
      { full_name: 'Anak Dua', birth_date: '2018-07-09', notes: null },
    ])
    expect(r.shape).toContain('dan')
  })

  it('semicolon-separated entries', () => {
    const r = parseChildrenCell('Anak Satu - 1 Jan 2014; Anak Dua - 2 Feb 2016; Anak Tiga - 3 Mar 2018')
    expect(r.children.map((c) => [c.full_name, c.birth_date])).toEqual([
      ['Anak Satu', '2014-01-01'],
      ['Anak Dua', '2016-02-02'],
      ['Anak Tiga', '2018-03-03'],
    ])
    expect(r.shape).toContain('semicolon')
  })

  it('date wrapped in parentheses, one per line', () => {
    const r = parseChildrenCell('Anak Satu (7 July 2015)\nAnak Dua (8 June 2017)')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2015-07-07', notes: null },
      { full_name: 'Anak Dua', birth_date: '2017-06-08', notes: null },
    ])
  })

  it('a 4-child newline list', () => {
    const r = parseChildrenCell(
      'Anak Satu - 1 Mei 2010\nAnak Dua - 2 Mei 2012\nAnak Tiga - 3 Mei 2014\nAnak Empat - 4 Mei 2016',
    )
    expect(r.children).toHaveLength(4)
    expect(r.children.every((c) => c.birth_date !== null && c.notes === null)).toBe(true)
  })

  it('a junk line of dots is dropped, not treated as an entry', () => {
    const r = parseChildrenCell('Anak Satu - 1 Mei 2010\nAnak Dua - 2 Mei 2012\n.....')
    expect(r.parked).toBeNull()
    expect(r.children).toHaveLength(2)
    expect(r.shape).toContain('junk-lines=1')
  })

  it('a name containing a month word is not mistaken for a date', () => {
    const r = parseChildrenCell('1. Mei Anak - 5 Juni 2016\n2. Juni Lestari - 6 Mei 2018')
    expect(r.children.map((c) => [c.full_name, c.birth_date])).toEqual([
      ['Mei Anak', '2016-06-05'],
      ['Juni Lestari', '2018-05-06'],
    ])
  })
})

describe('parseChildrenCell — birthplace middle field', () => {
  it('strips a KNOWN_CITIES place (dash + comma form)', () => {
    const r = parseChildrenCell('Anak Satu - Jakarta, 5 Mei 2016')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: '2016-05-05', notes: null }])
    expect(r.shape).toContain('place-stripped=1')
  })

  it("strips a KNOWN_CITIES place (comma form, 'dan'-separated)", () => {
    const r = parseChildrenCell('Anak Satu, Bandung 3 Maret 2015 dan Anak Dua, Bandung 9 Juli 2018')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2015-03-03', notes: null },
      { full_name: 'Anak Dua', birth_date: '2018-07-09', notes: null },
    ])
  })

  it('strips a place equal to the caller-supplied parent birthplace', () => {
    const r = parseChildrenCell('Anak Satu - Kotabaru 5 Mei 2016', 'KOTABARU')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: '2016-05-05', notes: null }])
  })

  it('ambiguous middle field: name kept UNTRUNCATED, raw entry parked in notes, date still set', () => {
    const r = parseChildrenCell('Anak Satu, Kenanga 5 Mei 2016')
    expect(r.parked).toBeNull()
    expect(r.children).toEqual([
      { full_name: 'Anak Satu, Kenanga', birth_date: '2016-05-05', notes: 'Anak Satu, Kenanga 5 Mei 2016' },
    ])
    expect(r.shape).toContain('middle-ambiguous=1')
  })

  it('same middle field is ambiguous when it does not match the parent birthplace', () => {
    const r = parseChildrenCell('Anak Satu - Kotabaru 5 Mei 2016', 'Kotalama')
    expect(r.children[0].full_name).toBe('Anak Satu - Kotabaru')
    expect(r.children[0].notes).toBe('Anak Satu - Kotabaru 5 Mei 2016')
  })

  it('unexpected text after the date is ambiguous too (notes = raw entry)', () => {
    const r = parseChildrenCell('Anak Satu 5 Mei 2016 Kenanga')
    expect(r.children).toEqual([
      { full_name: 'Anak Satu', birth_date: '2016-05-05', notes: 'Anak Satu 5 Mei 2016 Kenanga' },
    ])
  })
})

describe('parseChildrenCell — date handlers', () => {
  it('Indonesian full month names', () => {
    expect(parseChildrenCell('Anak Satu - 17 Desember 2013').children[0].birth_date).toBe('2013-12-17')
    expect(parseChildrenCell('Anak Satu - 1 Oktober 2020').children[0].birth_date).toBe('2020-10-01')
  })

  it('English full month names', () => {
    expect(parseChildrenCell('Anak Satu - 5 December 2016').children[0].birth_date).toBe('2016-12-05')
    expect(parseChildrenCell('Anak Satu - 9 February 2019').children[0].birth_date).toBe('2019-02-09')
  })

  it('abbreviations, case-insensitive (incl. uppercase AGS / MRT / OKT)', () => {
    expect(parseChildrenCell('Anak Satu - 10 AGS 2017').children[0].birth_date).toBe('2017-08-10')
    expect(parseChildrenCell('Anak Satu - 2 Mrt 2018').children[0].birth_date).toBe('2018-03-02')
    expect(parseChildrenCell('Anak Satu - 2 okt 2018').children[0].birth_date).toBe('2018-10-02')
    expect(parseChildrenCell('Anak Satu - 2 Des 2018').children[0].birth_date).toBe('2018-12-02')
    expect(parseChildrenCell('Anak Satu - 2 Agt 2018').children[0].birth_date).toBe('2018-08-02')
  })

  it('D/M/YY: 2-digit year pivots to 20YY', () => {
    expect(parseChildrenCell('Anak Satu 21/11/15').children[0].birth_date).toBe('2015-11-21')
  })

  it('D-M-YY ambiguous (both parts <= 12) reads day-first', () => {
    expect(parseChildrenCell('Anak Satu - 03-04-12').children[0].birth_date).toBe('2012-04-03')
    expect(parseChildrenCell('Anak Satu - 03/04/2012').children[0].birth_date).toBe('2012-04-03')
  })

  it('D - M - YYYY with spaces around the separators', () => {
    expect(parseChildrenCell('Anak Satu - 25 - 12 - 2015').children[0].birth_date).toBe('2015-12-25')
  })

  it('bare 8 digits parse as DDMMYYYY', () => {
    const r = parseChildrenCell('Anak Satu - Bandung - 15032017')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: '2017-03-15', notes: null }])
  })

  it('bare 6 digits are unresolvable: birth_date null, raw fragment in notes', () => {
    const r = parseChildrenCell('Anak Satu - Bandung 150317')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: null, notes: '150317' }])
    expect(r.shape).toContain('bare6(unresolved)')
  })

  it('no-year (MON D): birth_date null, raw fragment in notes', () => {
    const r = parseChildrenCell('Anak Satu Mei 12')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: null, notes: 'Mei 12' }])
  })

  it('no-year (D MON): birth_date null, raw fragment in notes', () => {
    const r = parseChildrenCell('Anak Satu - 12 Mei')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: null, notes: '12 Mei' }])
  })

  it('a single child with no date at all: null date, null notes', () => {
    const r = parseChildrenCell('Anak Satu')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: null, notes: null }])
    expect(r.shape).toContain('date=no-date')
  })
})

describe('parseChildrenCell — calendar validity', () => {
  it('rejects 31 Februari (impossible day): null date, raw fragment in notes', () => {
    const r = parseChildrenCell('Anak Satu - 31 Februari 2016')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: null, notes: '31 Februari 2016' }])
  })

  it('accepts 29 Feb in a leap year, rejects it otherwise', () => {
    expect(parseChildrenCell('Anak Satu 29/02/2016').children[0].birth_date).toBe('2016-02-29')
    expect(parseChildrenCell('Anak Satu 29/02/2015').children[0].birth_date).toBeNull()
  })

  it('rejects 31 April and a month > 12 (no month-first fallback)', () => {
    expect(parseChildrenCell('Anak Satu 31/04/2016').children[0].birth_date).toBeNull()
    expect(parseChildrenCell('Anak Satu 05/13/2016').children[0].birth_date).toBeNull()
  })

  it('toIsoDate / isValidIsoDate', () => {
    expect(toIsoDate(2016, 2, 29)).toBe('2016-02-29')
    expect(toIsoDate(1900, 2, 29)).toBeNull()
    expect(toIsoDate(2000, 2, 29)).toBe('2000-02-29')
    expect(toIsoDate(2016, 0, 1)).toBeNull()
    expect(isValidIsoDate('2016-05-05')).toBe(true)
    expect(isValidIsoDate('2016-02-30')).toBe(false)
    expect(isValidIsoDate('2016-5-5')).toBe(false)
  })
})

describe('parseChildrenCell — parking and omission', () => {
  it('multiline cell with name and date on separate lines parks the WHOLE cell', () => {
    const raw = '1. Anak Satu\nBandung, 5 Mei 2016\n2. Anak Dua\nBandung, 6 Juni 2018'
    const r = parseChildrenCell(raw)
    expect(r.children).toEqual([])
    expect(r.parked).toBe(`multiline-unsplittable: ${raw}`)
    expect(parkReasonOf(r.parked!)).toBe(PARK_REASONS.MULTILINE_UNSPLITTABLE)
    expect(r.shape).toBe('park:multiline-unsplittable;lines=4')
  })

  it('single line, no dates, but separators: parks (entries cannot be separated)', () => {
    const r = parseChildrenCell('Anak Satu, Anak Dua')
    expect(r.children).toEqual([])
    expect(parkReasonOf(r.parked!)).toBe(PARK_REASONS.NO_DATE_UNSPLITTABLE)
  })

  it('an entry with no extractable name is omitted (no placeholder row)', () => {
    const r = parseChildrenCell('Anak Satu - 5 Mei 2016, 6 Juni 2018')
    expect(r.children).toEqual([{ full_name: 'Anak Satu', birth_date: '2016-05-05', notes: null }])
    expect(r.omittedEntries).toBe(1)
    expect(r.shape).toContain('omitted=1')
  })

  it('a cell with only a date (no name anywhere) parks as no-name-extractable', () => {
    const r = parseChildrenCell('5 Mei 2016')
    expect(r.children).toEqual([])
    expect(parkReasonOf(r.parked!)).toBe(PARK_REASONS.NO_NAME_EXTRACTABLE)
  })

  it('empty / whitespace-only cell parks as empty', () => {
    expect(parseChildrenCell('   ').parked).toBe('empty: ')
  })

  it('shape never contains cell text', () => {
    const r = parseChildrenCell('Anak Satu, Kenanga 5 Mei 2016\nAnak Dua - Jakarta 6 Mei 2018')
    expect(r.shape).not.toMatch(/Anak|Kenanga|Jakarta|Mei|2016|2018/)
  })
})

describe('vocabulary exports', () => {
  it('KNOWN_CITIES hit / miss via isKnownPlace (case- and dot-insensitive)', () => {
    expect(KNOWN_CITIES.has('jakarta')).toBe(true)
    expect(isKnownPlace('JAKARTA')).toBe(true)
    expect(isKnownPlace('Bandar  Lampung')).toBe(true)
    expect(isKnownPlace('Sydney')).toBe(true)
    expect(isKnownPlace('Kenanga')).toBe(false)
    expect(isKnownPlace('')).toBe(false)
  })

  it('isKnownPlace honours the parent birthplace, and ignores an empty one', () => {
    expect(isKnownPlace('Kotabaru', 'kotabaru')).toBe(true)
    expect(isKnownPlace('Kotabaru', '')).toBe(false)
    expect(isKnownPlace('Kotabaru', null)).toBe(false)
  })

  it('MONTHS covers ID + EN names and abbreviations', () => {
    expect(MONTHS.mei).toBe(5)
    expect(MONTHS.may).toBe(5)
    expect(MONTHS.agustus).toBe(8)
    expect(MONTHS.ags).toBe(8)
    expect(MONTHS.nopember).toBe(11)
    expect(MONTHS.dec).toBe(12)
  })
})
