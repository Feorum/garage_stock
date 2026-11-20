"""Prepare resumable private SQL for installing a reviewed Garage Word master."""
import argparse
import base64
import hashlib
import json
import re
from datetime import date
from pathlib import Path
from zipfile import ZipFile

PART_SIZE = 24 * 1024
NUMBER = re.compile(r'[1-9][0-9]{0,14}/(?:0[1-9]|1[0-2])')


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def prepare(template, config, directory):
    with ZipFile(template) as archive:
        document = archive.read('word/document.xml')
    if not all(marker in document for marker in (b'{{GARAGE_ACT_NUMBER}}', b'<?garage-jobs-start?>')):
        raise ValueError('Prepare the private master with prepare-act-template.py first.')
    names = [config[key].strip() for key in ('customer_name', 'contractor_name', 'contract_number')]
    if not all(names):
        raise ValueError('Provide both parties and the contract number.')
    contract_date = date.fromisoformat(config['contract_date']).isoformat()
    reserved = config.get('reserved_numbers', [])
    if not isinstance(reserved, list) or any(not isinstance(n, str) or not NUMBER.fullmatch(n) for n in reserved):
        raise ValueError('Use N/MM for each previously issued act.')
    if len({int(n.split('/')[0]) for n in reserved}) != len(reserved):
        raise ValueError('A cumulative order number can only be used once.')
    last = max(reserved, key=lambda n: int(n.split('/')[0]), default=None)
    package = template.read_bytes()
    digest = hashlib.sha256(package).hexdigest()
    count = (len(package) + PART_SIZE - 1) // PART_SIZE
    directory.mkdir(exist_ok=True, parents=True)
    with (directory / 'parts.owner-only.sql').open('w', encoding='utf-8', newline='\n') as parts:
        for part_id, offset in enumerate(range(0, len(package), PART_SIZE)):
            encoded = base64.b64encode(package[offset:offset + PART_SIZE]).decode('ascii')
            parts.write(f"insert into garage_act.template_parts(part_index,data_base64) values ({part_id},'{encoded}') on conflict(part_index) do nothing;\n")
    # Publish only after the stored content reproduces the original private file byte for byte.
    quoted = ','.join(literal(v) for v in [*names, contract_date])
    values = ','.join('(' + literal(v) + ')' for v in reserved)
    registry = f"insert into garage_act.reserved_numbers(number) values {values} on conflict(number) do nothing;" if values else ''
    activate = f"""begin;
set local standard_conforming_strings=on;
lock table garage_act.config, garage_act.template_parts, garage_act.reserved_numbers in share row exclusive mode;
do $verify$ begin
  if (select count(*)={count} and min(part_index)=0 and max(part_index)={count-1}
      and encode(sha256(decode(string_agg(data_base64,'' order by part_index),'base64')),'hex')='{digest}'
      from garage_act.template_parts) is not true then
    raise exception 'Stored Word master is incomplete or differs from the supplied file.';
  end if;
end $verify$;
{registry}
insert into garage_act.config(customer_name,contractor_name,contract_number,contract_date,template_chunks,last_issued_number)
values ({quoted},{count},{literal(last) if last else 'null'}) on conflict(singleton) do nothing;
commit;
"""
    (directory / 'activate.owner-only.sql').write_text(activate, encoding='utf-8')
    return count, digest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('template', type=Path)
    parser.add_argument('config', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    chunks, sha = prepare(args.template, json.loads(args.config.read_text(encoding='utf-8-sig')), args.output)
    print(f'Prepared {chunks} private parts. SHA-256 {sha}.')
