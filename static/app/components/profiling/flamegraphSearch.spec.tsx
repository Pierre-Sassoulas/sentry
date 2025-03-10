import {FlamegraphFrame} from 'sentry/utils/profiling/flamegraphFrame';

import {searchFzf, searchRegExp} from './flamegraph/flamegraphToolbar/flamegraphSearch';

const f = (name: string) => {
  return {
    frame: {
      name,
    },
  } as FlamegraphFrame;
};

describe('fzf', () => {
  it('matches only first occurence', () => {
    expect(searchFzf(f('foofoo'), new Map(), 'foo')).toMatchObject({
      start: 0,
      end: 3,
      matches: [[0, 3]],
    });
  });

  it('prefers matches at start', () => {
    expect(searchFzf(f('f'), new Map(), 'f').score).toBeGreaterThan(
      searchFzf(f('of'), new Map(), 'f').score
    );
  });

  it('penalizes gaps', () => {
    expect(searchFzf(f('f oo'), new Map(), 'foo').score).toBeLessThan(
      searchFzf(f('foo'), new Map(), 'foo').score
    );
  });

  it('narrows down indices on backtracking', () => {
    // https://github.com/junegunn/fzf/blob/f81feb1e69e5cb75797d50817752ddfe4933cd68/src/algo/algo.go#L13
    expect(searchFzf(f('a_____b___abc__'), new Map(), 'abc').matches).toEqual([[10, 13]]);
  });
});

describe('regexp', () => {
  it('finds all matches', () => {
    expect(searchRegExp(f('foofoo'), new Map(), 'foo', 'g')).toEqual([0, 3]);
  });
});
