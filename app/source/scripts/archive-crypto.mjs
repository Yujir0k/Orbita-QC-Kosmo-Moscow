import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generateArchiveRecipient,sealArchive,openArchive } from '../server/hybrid-crypto.mjs';
const [command,keyFile,inputFile,outputFile]=process.argv.slice(2);
if(command==='generate' && keyFile) {
  await writeFile(keyFile,JSON.stringify(generateArchiveRecipient(`archive-${randomUUID()}`)),{mode:0o600,flag:'wx'});
} else if(command==='seal' && outputFile) {
  const recipient=JSON.parse(await readFile(keyFile,'utf8'));
  const input=JSON.parse(await readFile(inputFile,'utf8'));
  await writeFile(outputFile,JSON.stringify(sealArchive(input,recipient,input.event_id ?? input.backupId ?? inputFile)),{mode:0o600,flag:'wx'});
} else if(command==='open' && outputFile) {
  const recipient=JSON.parse(await readFile(keyFile,'utf8'));
  const envelope=JSON.parse(await readFile(inputFile,'utf8'));
  await writeFile(outputFile,JSON.stringify(openArchive(envelope,{[recipient.keyId]:recipient})),{mode:0o600,flag:'wx'});
} else throw new Error('Usage: archive-crypto.mjs generate keys.json | seal/open keys.json input.json output.json');
