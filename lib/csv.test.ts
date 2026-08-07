import { describe, it, expect } from 'vitest'
import {
  detectDelimiter,
  findColumn,
  firstLine,
  iterateCsvRows,
  normaliseSku,
  parseCsv,
  parseStockValue,
  splitLine,
  stripBom,
} from '@/modules/stock-import-for-shop/lib/csv'

describe('stripBom', () => {
  it('removes a UTF-8 byte-order mark', () => {
    expect(stripBom('﻿ProductCode,Qty')).toBe('ProductCode,Qty')
  })
  it('leaves a clean string alone', () => {
    expect(stripBom('ProductCode,Qty')).toBe('ProductCode,Qty')
  })
})

describe('detectDelimiter', () => {
  it('finds a comma', () => {
    expect(detectDelimiter('ProductCode,Description,FreeStock')).toBe(',')
  })
  it('finds a semicolon over a comma used as a decimal point', () => {
    expect(detectDelimiter('Code;Description;Free stock')).toBe(';')
  })
  it('finds a tab', () => {
    expect(detectDelimiter('Code\tDescription\tFreeStock')).toBe('\t')
  })
  it('falls back to a comma on a single-column file', () => {
    expect(detectDelimiter('ProductCode')).toBe(',')
  })
})

describe('splitLine', () => {
  it('honours quoted fields containing the delimiter', () => {
    expect(splitLine('AC1,"Chair, black",12', ',')).toEqual(['AC1', 'Chair, black', '12'])
  })
  it('unescapes doubled quotes', () => {
    expect(splitLine('AC1,"24"" monitor arm",3', ',')).toEqual(['AC1', '24" monitor arm', '3'])
  })
  it('reads an inch mark mid-field as an ordinary character', () => {
    expect(splitLine('AC000031,Gas Lift 7" Black,32,32,,5', ',')).toEqual([
      'AC000031',
      'Gas Lift 7" Black',
      '32',
      '32',
      '',
      '5',
    ])
  })
  it('leaves doubled quotes mid-field alone rather than unescaping them', () => {
    expect(splitLine('CB0101K,Phoenix 8"" Cash Box,250', ',')).toEqual([
      'CB0101K',
      'Phoenix 8"" Cash Box',
      '250',
    ])
  })
  it('does not let an inch mark swallow the rest of the line', () => {
    expect(splitLine('AC1,7" arm,4', ',')).toHaveLength(3)
  })
})

describe('iterateCsvRows', () => {
  const csv = 'ProductCode,ProductDescription,Quantity,FreeStock\r\nAC000001,Chiro Arm,360,355\r\nAC000002,"ISO, Black",602,602\r\n'

  it('reads CRLF rows and quoted commas', () => {
    expect([...iterateCsvRows(csv)]).toEqual([
      ['ProductCode', 'ProductDescription', 'Quantity', 'FreeStock'],
      ['AC000001', 'Chiro Arm', '360', '355'],
      ['AC000002', 'ISO, Black', '602', '602'],
    ])
  })

  it('drops blank padding lines but keeps genuinely empty fields', () => {
    expect(parseCsv('a,b\n\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ])
  })

  it('keeps a newline that lives inside a quoted field', () => {
    expect(parseCsv('code,note\nAC1,"line one\nline two"\n')).toEqual([
      ['code', 'note'],
      ['AC1', 'line one\nline two'],
    ])
  })

  it('reads the last row when the file has no trailing newline', () => {
    expect(parseCsv('code,qty\nAC1,4')).toEqual([
      ['code', 'qty'],
      ['AC1', '4'],
    ])
  })

  it('handles lone carriage returns', () => {
    expect(parseCsv('code,qty\rAC1,4\r')).toEqual([
      ['code', 'qty'],
      ['AC1', '4'],
    ])
  })

  // The supplier writes gas lift sizes in inches and does not escape the mark.
  // Read as an opening quote it swallows the line ending, absorbs the next row
  // into the description, and that row's product code never reaches the import
  // at all - so the product quietly stops receiving stock counts and is
  // reported as absent from a file it is plainly in.
  it('keeps the row after an unescaped inch mark, product code and all', () => {
    const csv = [
      'ProductCode,ProductDescription,Quantity,FreeStock,DueDate,LeadTime',
      'AC000031,Gas Lift 7" Black,32,32,,5',
      'AC000032,Gas Lift 9" Black,109,109,,5',
      'AC000033,Gas Lift 11" Black,23,23,,5',
      '',
    ].join('\r\n')

    const rows = [...iterateCsvRows(csv)]
    expect(rows).toHaveLength(4)
    expect(rows.slice(1).map((row) => row[0])).toEqual(['AC000031', 'AC000032', 'AC000033'])
    expect(rows[1]?.[1]).toBe('Gas Lift 7" Black')
    expect(rows[1]).toHaveLength(6)
  })

  it('leaves a doubled quote mid-field alone without eating the next row', () => {
    const csv = [
      'ProductCode,ProductDescription,FreeStock',
      'CB0101K,Phoenix 8"" Cash Box CB0101K with Key Lock,250',
      'CB0102K,Phoenix 10"" Cash Box CB0102K with Key Lock,250',
      '',
    ].join('\n')

    expect(parseCsv(csv)).toEqual([
      ['ProductCode', 'ProductDescription', 'FreeStock'],
      ['CB0101K', 'Phoenix 8"" Cash Box CB0101K with Key Lock', '250'],
      ['CB0102K', 'Phoenix 10"" Cash Box CB0102K with Key Lock', '250'],
    ])
  })

  it('still reads a properly quoted field holding the delimiter and a newline', () => {
    const csv = 'code,note,qty\nAC1,"Chair, black\nsecond line",7\nAC2,plain,8\n'

    expect(parseCsv(csv)).toEqual([
      ['code', 'note', 'qty'],
      ['AC1', 'Chair, black\nsecond line', '7'],
      ['AC2', 'plain', '8'],
    ])
  })

  it('still unescapes doubled quotes inside a properly quoted field', () => {
    expect(parseCsv('code,note\nAC1,"a ""quoted"" word",\n')).toEqual([
      ['code', 'note'],
      ['AC1', 'a "quoted" word', ''],
    ])
  })
})

describe('firstLine', () => {
  it('stops at the first break and strips the carriage return', () => {
    expect(firstLine('a,b\r\nc,d\r\n')).toBe('a,b')
  })
  it('returns the whole string when there is no break', () => {
    expect(firstLine('a,b')).toBe('a,b')
  })
})

describe('findColumn', () => {
  const header = ['ProductCode', 'Product Description', 'Quantity', 'Free_Stock']

  it('matches ignoring case, spaces, underscores and hyphens', () => {
    expect(findColumn(header, 'freestock')).toBe(3)
    expect(findColumn(header, 'Free Stock')).toBe(3)
    expect(findColumn(header, 'product-description')).toBe(1)
  })
  it('returns -1 for a column that is not there', () => {
    expect(findColumn(header, 'OnOrder')).toBe(-1)
  })
  it('returns -1 for an empty name rather than matching an empty header', () => {
    expect(findColumn(['', 'Qty'], '')).toBe(-1)
  })
})

describe('parseStockValue', () => {
  it('reads plain whole numbers', () => {
    expect(parseStockValue('360')).toBe(360)
  })
  it('reads decimals down, never up', () => {
    expect(parseStockValue('360.00')).toBe(360)
    expect(parseStockValue('12.9')).toBe(12)
  })
  it('reads thousands separators', () => {
    expect(parseStockValue('1,250')).toBe(1250)
  })
  it('floors negatives and accountant brackets at zero', () => {
    expect(parseStockValue('-4')).toBe(0)
    expect(parseStockValue('(5)')).toBe(0)
  })
  it('returns null for an empty or unreadable cell rather than guessing', () => {
    expect(parseStockValue('')).toBeNull()
    expect(parseStockValue('   ')).toBeNull()
    expect(parseStockValue('In stock')).toBeNull()
    expect(parseStockValue('-')).toBeNull()
    expect(parseStockValue('12abc')).toBeNull()
  })
})

describe('normaliseSku', () => {
  it('trims and upper-cases', () => {
    expect(normaliseSku('  ac000001 ')).toBe('AC000001')
  })
})
