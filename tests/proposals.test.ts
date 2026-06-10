// The governance gate exists before there is anything to gate: the queue is
// empty by design, and a missing directory is still an empty queue, not an error.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readProposals } from '../src/proposals.js';

const here = dirname(fileURLToPath(import.meta.url));
const proposalsDir = join(here, '..', 'proposals');

describe('proposals queue', () => {
  it('returns the empty queue shape', async () => {
    const queue = await readProposals(proposalsDir);
    expect(queue).toEqual({ count: 0, proposals: [] });
  });

  it('treats a missing directory as an empty queue', async () => {
    const queue = await readProposals(join(here, 'no-such-dir'));
    expect(queue).toEqual({ count: 0, proposals: [] });
  });
});
