import { imageAutonomy } from '../lib/types';

describe('imageAutonomy', () => {
  it('grants nothing by default', () => {
    expect(imageAutonomy(undefined)).toEqual({ size: false, aspect: false });
    expect(imageAutonomy({})).toEqual({ size: false, aspect: false });
  });

  it('reads the two new toggles independently', () => {
    expect(imageAutonomy({ choomDecidesAspect: true })).toEqual({ size: false, aspect: true });
    expect(imageAutonomy({ choomDecidesSize: true })).toEqual({ size: true, aspect: false });
  });

  it('treats the legacy single toggle as both', () => {
    expect(imageAutonomy({ choomDecides: true })).toEqual({ size: true, aspect: true });
  });

  it('lets an explicit new toggle override the legacy one', () => {
    // A Choom saved with choomDecides:true, then size switched off.
    expect(imageAutonomy({ choomDecides: true, choomDecidesSize: false })).toEqual({ size: false, aspect: true });
  });
});
