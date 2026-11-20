"""Prepare the private Word act master. Usage: python prepare-act-template.py source.docx private.docx"""
import argparse
import re
import tempfile
from pathlib import Path
from xml.dom import Node, minidom
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
WORD2010 = 'http://schemas.microsoft.com/office/word/2010/wordml'
XML = 'http://www.w3.org/XML/1998/namespace'


def elements(node):
    return [child for child in node.childNodes if child.nodeType == Node.ELEMENT_NODE]


def text_nodes(paragraph):
    return list(paragraph.getElementsByTagNameNS(WORD, 't'))


def text(node):
    return ''.join(child.data for child in node.childNodes if child.nodeType == Node.TEXT_NODE)


def mark(paragraph, pattern, label):
    """Replace named ranges in the original styled runs, including ranges split by Word."""
    nodes = text_nodes(paragraph)
    contents = [text(node) for node in nodes]
    match = re.search(pattern, ''.join(contents), re.I)
    if not match:
        raise ValueError(f'Unsupported form: could not identify the {label} field.')
    for key in reversed(list(match.groupdict())):
        begin, end = match.span(key)
        offset = 0
        for i, old in enumerate(contents):
            boundary = offset + len(old)
            if boundary > begin and offset < end:
                prefix = old[:max(0, begin - offset)]
                marker = '{{GARAGE_' + key + '}}' if offset <= begin else ''
                contents[i] = prefix + marker + old[max(0, end - offset):]
            offset = boundary
    for node, new in zip(nodes, contents):
        if text(node) == new:
            continue
        for child in list(node.childNodes):
            node.removeChild(child)
        node.appendChild(node.ownerDocument.createTextNode(new))
        if new != new.strip():
            node.setAttributeNS(XML, 'xml:space', 'preserve')


def keep_signatures_together(blocks):
    """Word keeps the party-details row and its signatures together when a long list grows."""
    table = blocks[15]
    rows = table.getElementsByTagNameNS(WORD, 'tr')
    if len(rows) != 1 or blocks[19].localName != 'p':
        raise ValueError('Unsupported form: expected a single party-details row followed by the signature block.')
    doc = table.ownerDocument
    row = rows[0]
    props = next((child for child in elements(row) if child.localName == 'trPr'), None)
    if props is None:
        props = doc.createElementNS(WORD, 'w:trPr')
        row.insertBefore(props, row.firstChild)
    if not props.getElementsByTagNameNS(WORD, 'cantSplit'):
        props.insertBefore(doc.createElementNS(WORD, 'w:cantSplit'), props.firstChild)
    for paragraph in [*table.getElementsByTagNameNS(WORD, 'p'), *blocks[16:20]]:
        props = next((child for child in elements(paragraph) if child.localName == 'pPr'), None)
        if props is None:
            props = doc.createElementNS(WORD, 'w:pPr')
            paragraph.insertBefore(props, paragraph.firstChild)
        for child in list(elements(props)):
            if child.localName in ('keepNext', 'keepLines'):
                props.removeChild(child)
        anchor = next((child for child in elements(props) if child.localName != 'pStyle'), None)
        if paragraph is not blocks[19]:
            props.insertBefore(doc.createElementNS(WORD, 'w:keepNext'), anchor)
        props.insertBefore(doc.createElementNS(WORD, 'w:keepLines'), anchor)


def document_xml(data):
    doc = minidom.parseString(data)
    body, = doc.getElementsByTagNameNS(WORD, 'body')
    blocks = elements(body)
    if (len(blocks) < 20 or blocks[15].localName != 'tbl'
            or any(blocks[i].localName != 'p' for i in (0, 1, 5, 8, 10, 12, 16, 17, 18, 19))):
        raise ValueError('Unsupported form: the order fields, party table or signatures have moved.')
    mark(blocks[0], r'^АКТ\s+.+оказанных услуг\s*№\s*(?P<ACT_NUMBER>.+?)\s*$', 'act number')
    mark(blocks[1], r'^к договору\s+(?P<CONTRACT_NUMBER>.+?)\s+(?P<CONTRACT_DATE>«\d{1,2}»\s+\w+\s+\d{4}\s+года)\s*$', 'contract')
    mark(blocks[5], r'^\s*(?P<ACT_DATE>«\d{1,2}»\s+\w+\s+\d{4}\s+г\.)\s*$', 'act date')
    mark(blocks[8], r'\bпо автомобилю\s+(?P<VEHICLE>.+?)\s+вин номер:\s*(?P<VIN>\S+)\s*$', 'vehicle and VIN')
    job = blocks[10]
    mark(job, r'^(?P<JOB_NAME>.+?)\s+[–—-]\s+(?P<JOB_PRICE>[\d \xa0\u202f]+,\d{2})\s+BYN\s*$', 'job and price')
    # Word assigns unique IDs to paragraphs. Repeated job lines should get new IDs when opened.
    for key in ('paraId', 'textId'):
        if job.hasAttributeNS(WORD2010, key):
            job.removeAttributeNS(WORD2010, key)
    body.insertBefore(doc.createProcessingInstruction('garage-jobs-start', ''), job)
    body.insertBefore(doc.createProcessingInstruction('garage-jobs-end', ''), job.nextSibling)
    mark(blocks[12], r'\bСтоимость оказанных услуг составляет\s+(?P<TOTAL>.+?)\s+без НДС\.\s*$', 'total')
    keep_signatures_together(blocks)
    # minidom writes an optional space ahead of the PI terminator; canonicalize the two markers.
    return re.sub(rb'<\?(garage-jobs-(?:start|end))\s*\?>', rb'<?\1?>', doc.toxml(encoding='UTF-8'))


def strip_source_metadata(name, data):
    doc = minidom.parseString(data)
    root = doc.documentElement
    for child in elements(root):
        if name == 'docProps/core.xml':
            root.removeChild(child)
        elif child.getAttribute('PartName').startswith('/customXml/') or child.getAttribute('Type').endswith('/customXml'):
            root.removeChild(child)
    return doc.toxml(encoding='UTF-8')


def prepare(source: Path, output: Path):
    if source.resolve() == output.resolve():
        raise ValueError('Use a separate output for the private master.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        temporary = Path(directory) / 'master.docx'
        with ZipFile(source) as original, ZipFile(temporary, 'w') as result:
            if not {'word/document.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'}.issubset(original.namelist()):
                raise ValueError('The source must be a Word document containing the supported form.')
            for item in original.infolist():
                name = item.filename
                if name.startswith('customXml/'):
                    continue
                data = original.read(item)
                if name == 'word/document.xml':
                    data = document_xml(data)
                elif name in ('[Content_Types].xml', 'word/_rels/document.xml.rels', 'docProps/core.xml'):
                    data = strip_source_metadata(name, data)
                result.writestr(ZipInfo(name), data, ZIP_DEFLATED)
        temporary.replace(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    prepare(args.source, args.output)
