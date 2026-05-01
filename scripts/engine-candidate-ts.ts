import {
  assertEngineCandidateRequest,
  runEngineCandidateRequest,
} from '../src/engine-compare';

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const rawInput = await readStdin();
const parsed = JSON.parse(rawInput) as unknown;
assertEngineCandidateRequest(parsed);
const response = runEngineCandidateRequest(parsed);
process.stdout.write(`${JSON.stringify(response)}\n`);
