import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function main() {
  const response = await client.responses.create({
    model: 'gpt-5.4',
    input: 'Say "API connection working" and list 3 words: fidelity, sensitivity, completeness.',
  });

  console.log(response.output_text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
