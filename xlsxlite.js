/**
 * xlsxlite.js — minimal, dependency-free XLSX writer.
 *
 * Built from scratch (no exceljs/xlsx package) because neither was
 * installable in the environment this was developed in (no network
 * access). Uses only Node built-ins. Supports what this project's reports
 * need: multiple sheets, string/number/formula cells, bold/fill/font-color
 * styling, number formats (currency/percent/etc), column widths, and
 * frozen header rows. ZIP entries are stored uncompressed (method 0) —
 * simpler and fully verifiable without needing deflate round-trip testing;
 * the size cost is negligible for spreadsheet-sized XML.
 *
 * Usage:
 *   const wb = new Workbook();
 *   const ws = wb.addSheet('Trades');
 *   ws.setColumns([{ width: 12 }, { width: 10 }]);
 *   ws.addRow(['Symbol', 'P/L'], { bold: true });
 *   ws.addRow(['AAPL', 123.45], { numFmts: [null, '$#,##0.00'] });
 *   wb.writeFile('./out.xlsx');
 */

'use strict';

const fs   = require('fs');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3) — verified against the standard test vector
// CRC32("123456789") === 0xCBF43926
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (STORE method — uncompressed entries)
// ---------------------------------------------------------------------------
class ZipWriter {
    constructor() {
        this.entries = []; // { name, data }
    }
    addFile(name, content) {
        const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        this.entries.push({ name, data });
    }
    toBuffer() {
        const chunks = [];
        const central = [];
        let offset = 0;
        const dosTime = 0, dosDate = 0x21; // fixed arbitrary valid DOS date (Jan 1 1980-ish); fine, timestamps aren't load-bearing here

        for (const { name, data } of this.entries) {
            const nameBuf = Buffer.from(name, 'utf8');
            const crc = crc32(data);
            const localHeader = Buffer.alloc(30);
            localHeader.writeUInt32LE(0x04034b50, 0);
            localHeader.writeUInt16LE(20, 4);       // version needed
            localHeader.writeUInt16LE(0x0800, 6);   // flags: UTF-8 names
            localHeader.writeUInt16LE(0, 8);        // method: store
            localHeader.writeUInt16LE(dosTime, 10);
            localHeader.writeUInt16LE(dosDate, 12);
            localHeader.writeUInt32LE(crc, 14);
            localHeader.writeUInt32LE(data.length, 18); // compressed size
            localHeader.writeUInt32LE(data.length, 22); // uncompressed size
            localHeader.writeUInt16LE(nameBuf.length, 26);
            localHeader.writeUInt16LE(0, 28);       // extra field length

            chunks.push(localHeader, nameBuf, data);

            central.push({ nameBuf, crc, size: data.length, offset });
            offset += localHeader.length + nameBuf.length + data.length;
        }

        const centralStart = offset;
        for (const e of central) {
            const ch = Buffer.alloc(46);
            ch.writeUInt32LE(0x02014b50, 0);
            ch.writeUInt16LE(20, 4);   // version made by
            ch.writeUInt16LE(20, 6);   // version needed
            ch.writeUInt16LE(0x0800, 8);
            ch.writeUInt16LE(0, 10);   // method: store
            ch.writeUInt16LE(dosTime, 12);
            ch.writeUInt16LE(dosDate, 14);
            ch.writeUInt32LE(e.crc, 16);
            ch.writeUInt32LE(e.size, 20); // compressed
            ch.writeUInt32LE(e.size, 24); // uncompressed
            ch.writeUInt16LE(e.nameBuf.length, 28);
            ch.writeUInt16LE(0, 30);  // extra len
            ch.writeUInt16LE(0, 32);  // comment len
            ch.writeUInt16LE(0, 34);  // disk number start
            ch.writeUInt16LE(0, 36);  // internal attrs
            ch.writeUInt32LE(0, 38);  // external attrs
            ch.writeUInt32LE(e.offset, 42);
            chunks.push(ch, e.nameBuf);
            offset += ch.length + e.nameBuf.length;
        }
        const centralSize = offset - centralStart;

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(central.length, 8);
        eocd.writeUInt16LE(central.length, 10);
        eocd.writeUInt32LE(centralSize, 12);
        eocd.writeUInt32LE(centralStart, 16);
        eocd.writeUInt16LE(0, 20);
        chunks.push(eocd);

        return Buffer.concat(chunks);
    }
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------
function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function colLetter(n) {
    // 1-indexed column number -> "A", "B", ..., "AA", ...
    let s = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        s = String.fromCharCode(65 + rem) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

// ---------------------------------------------------------------------------
// Style registry — dedupes (bold, fill, fontColor, numFmt) combinations into
// a shared styles.xml, since every cell must reference a style INDEX.
// ---------------------------------------------------------------------------
const BUILTIN_NUMFMTS = {
    'General': 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4,
    '0%': 9, '0.00%': 10,
};

class StyleRegistry {
    constructor() {
        this.numFmts = []; // { id, code }
        this.nextNumFmtId = 164; // custom formats start at 164 per OOXML spec
        this.fonts = [{ bold: false, color: null }]; // index 0 = default
        this.fills = [{ color: null }, { color: null }]; // 0,1 reserved by spec (none, gray125)
        this.cellXfs = [{ fontId: 0, fillId: 0, numFmtId: 0 }]; // index 0 = default
        this._cache = new Map();
    }

    _numFmtId(code) {
        if (!code || code === 'General') return 0;
        if (BUILTIN_NUMFMTS[code] !== undefined) return BUILTIN_NUMFMTS[code];
        const existing = this.numFmts.find(f => f.code === code);
        if (existing) return existing.id;
        const id = this.nextNumFmtId++;
        this.numFmts.push({ id, code });
        return id;
    }

    /** Returns a style index for the given options, creating one if needed. */
    getStyle({ bold = false, fillColor = null, fontColor = null, numFmt = null } = {}) {
        const key = `${bold}|${fillColor}|${fontColor}|${numFmt}`;
        if (this._cache.has(key)) return this._cache.get(key);

        let fontId = 0;
        if (bold || fontColor) {
            fontId = this.fonts.length;
            this.fonts.push({ bold, color: fontColor });
        }
        let fillId = 0;
        if (fillColor) {
            fillId = this.fills.length;
            this.fills.push({ color: fillColor });
        }
        const numFmtId = this._numFmtId(numFmt);

        const xfId = this.cellXfs.length;
        this.cellXfs.push({ fontId, fillId, numFmtId });
        this._cache.set(key, xfId);
        return xfId;
    }

    toXml() {
        const numFmtXml = this.numFmts.length
            ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map(f =>
                `<numFmt numFmtId="${f.id}" formatCode="${xmlEscape(f.code)}"/>`).join('')}</numFmts>`
            : '';

        const fontsXml = `<fonts count="${this.fonts.length}">${this.fonts.map(f => {
            const parts = ['<name val="Arial"/>', '<sz val="10"/>'];
            if (f.bold) parts.push('<b/>');
            if (f.color) parts.push(`<color rgb="${f.color}"/>`);
            return `<font>${parts.join('')}</font>`;
        }).join('')}</fonts>`;

        const fillsXml = `<fills count="${this.fills.length}">${this.fills.map(f => {
            if (!f.color) return '<fill><patternFill patternType="none"/></fill>';
            return `<fill><patternFill patternType="solid"><fgColor rgb="${f.color}"/><bgColor indexed="64"/></patternFill></fill>`;
        }).join('')}</fills>`;

        const xfsXml = `<cellXfs count="${this.cellXfs.length}">${this.cellXfs.map(xf =>
            `<xf numFmtId="${xf.numFmtId}" fontId="${xf.fontId}" fillId="${xf.fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>`
        ).join('')}</cellXfs>`;

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmtXml}
${fontsXml}
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
${xfsXml}
${fillsXml}
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
    }
}

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------
class Worksheet {
    constructor(name, styleRegistry) {
        this.name = name;
        this.styles = styleRegistry;
        this.rows = []; // each: [{ value, type, styleIdx }]
        this.columns = []; // [{ width }]
        this.freezeHeaderRow = false;
        this.autoFilter = null; // 'A1:F1' style range, optional
    }

    setColumns(cols) { this.columns = cols; return this; }
    freezeTopRow() { this.freezeHeaderRow = true; return this; }
    setAutoFilter(range) { this.autoFilter = range; return this; }

    /**
     * Add a row. `values` is an array of primitives, strings, numbers, or
     * {formula: '...'} objects. `opts.numFmts` / `opts.bold` / `opts.fillColor`
     * / `opts.fontColor` can be a single value (applies to the whole row) or
     * a parallel array (per-cell).
     */
    addRow(values, opts = {}) {
        const n = values.length;
        const arr = (v) => Array.isArray(v) ? v : Array(n).fill(v);
        const bolds  = arr(opts.bold || false);
        const fills  = arr(opts.fillColor || null);
        const fonts  = arr(opts.fontColor || null);
        const fmts   = arr(opts.numFmts || null);

        const row = values.map((v, i) => {
            const styleIdx = this.styles.getStyle({
                bold: bolds[i], fillColor: fills[i], fontColor: fonts[i], numFmt: fmts[i]
            });
            if (v && typeof v === 'object' && 'formula' in v) {
                return { type: 'formula', value: v.formula, styleIdx };
            }
            if (typeof v === 'number') return { type: 'number', value: v, styleIdx };
            if (v === null || v === undefined) return { type: 'blank', value: '', styleIdx };
            return { type: 'string', value: String(v), styleIdx };
        });
        this.rows.push(row);
        return this;
    }

    toXml() {
        const colsXml = this.columns.length
            ? `<cols>${this.columns.map((c, i) =>
                `<col min="${i + 1}" max="${i + 1}" width="${c.width || 10}" customWidth="1"/>`).join('')}</cols>`
            : '';

        const sheetViewsXml = this.freezeHeaderRow
            ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
            : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;

        const rowsXml = this.rows.map((row, rIdx) => {
            const r = rIdx + 1;
            const cellsXml = row.map((cell, cIdx) => {
                const ref = `${colLetter(cIdx + 1)}${r}`;
                if (cell.type === 'formula') {
                    return `<c r="${ref}" s="${cell.styleIdx}"><f>${xmlEscape(cell.value)}</f></c>`;
                }
                if (cell.type === 'number') {
                    return `<c r="${ref}" s="${cell.styleIdx}"><v>${cell.value}</v></c>`;
                }
                if (cell.type === 'blank') {
                    return `<c r="${ref}" s="${cell.styleIdx}"/>`;
                }
                return `<c r="${ref}" s="${cell.styleIdx}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
            }).join('');
            return `<row r="${r}">${cellsXml}</row>`;
        }).join('');

        const dim = this.rows.length
            ? `A1:${colLetter(Math.max(...this.rows.map(r => r.length)))}${this.rows.length}`
            : 'A1';

        const autoFilterXml = this.autoFilter ? `<autoFilter ref="${this.autoFilter}"/>` : '';

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dim}"/>
${sheetViewsXml}
${colsXml}
<sheetData>${rowsXml}</sheetData>
${autoFilterXml}
</worksheet>`;
    }
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------
class Workbook {
    constructor() {
        this.sheets = [];
        this.styles = new StyleRegistry();
    }

    addSheet(name) {
        const ws = new Worksheet(name, this.styles);
        this.sheets.push(ws);
        return ws;
    }

    _contentTypesXml() {
        const overrides = this.sheets.map((s, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        ).join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
    }

    _rootRelsXml() {
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    }

    _workbookXml() {
        const sheetsXml = this.sheets.map((s, i) =>
            `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        ).join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetsXml}</sheets>
</workbook>`;
    }

    _workbookRelsXml() {
        const sheetRels = this.sheets.map((s, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        ).join('');
        const stylesRel = `<Relationship Id="rId${this.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
${stylesRel}
</Relationships>`;
    }

    toBuffer() {
        const zip = new ZipWriter();
        zip.addFile('[Content_Types].xml', this._contentTypesXml());
        zip.addFile('_rels/.rels', this._rootRelsXml());
        zip.addFile('xl/workbook.xml', this._workbookXml());
        zip.addFile('xl/_rels/workbook.xml.rels', this._workbookRelsXml());
        zip.addFile('xl/styles.xml', this.styles.toXml());
        this.sheets.forEach((s, i) => {
            zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, s.toXml());
        });
        return zip.toBuffer();
    }

    writeFile(path) {
        fs.writeFileSync(path, this.toBuffer());
    }
}

module.exports = { Workbook, crc32 };
