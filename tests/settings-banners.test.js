import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsForClient } from '../src/modules/settings/settings.routes.js';
import { StoreSettings } from '../src/modules/settings/storeSettings.model.js';

test('public settings expose only active banners inside their campaign window', () => {
  const active = { title: 'Live', image: 'https://cdn.example.com/live.webp', imagePublicId: 'private/live', isActive: true };
  const paused = { title: 'Paused', image: 'https://cdn.example.com/paused.webp', imagePublicId: 'private/paused', isActive: false };
  const future = { title: 'Future', image: 'https://cdn.example.com/future.webp', startsAt: '2999-01-01T00:00:00.000Z', isActive: true };
  const expired = { title: 'Expired', image: 'https://cdn.example.com/expired.webp', endsAt: '2020-01-01T00:00:00.000Z', isActive: true };

  const result = settingsForClient({ homepageBanners: [active, paused, future, expired] }, { headers: {} });

  assert.deepEqual(result.homepageBanners.map((banner) => banner.title), ['Live']);
  assert.equal(Object.hasOwn(result.homepageBanners[0], 'imagePublicId'), false);
  assert.deepEqual(result.homepageBannerPlacementsConfigured, { hero: true, middle: false });
});

test('store settings persist professional banner presentation and campaign fields', () => {
  const settings = new StoreSettings({
    homepageBanners: [{
      placement: 'middle',
      displayStyle: 'image-only',
      image: 'https://cdn.example.com/middle.webp',
      altText: 'Household essentials promotion',
      ctaHref: '/category/household-care',
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-09-01T00:00:00.000Z'),
    }],
  });

  assert.equal(settings.validateSync(), undefined);
  assert.equal(settings.homepageBanners[0].theme, 'dark');
  assert.equal(settings.homepageBanners[0].overlayOpacity, 55);
  assert.equal(settings.homepageBannerSections.middle.title, 'Everyday essentials');
});
