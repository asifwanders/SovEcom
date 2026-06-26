import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { WIDGET_TYPES, type WidgetDescriptor } from '@sovecom/theme-sdk';
import {
  widgetRegistry,
  getWidget,
  renderReadOnlyWidget,
  renderPersonalizedWidget,
} from './registry';

describe('widgetRegistry (closed MIT vocabulary)', () => {
  it('registers metadata for EVERY type in the closed C1 vocabulary', () => {
    for (const type of WIDGET_TYPES) {
      const entry = getWidget(type);
      expect(entry, `expected a registered widget for "${type}"`).toBeDefined();
      expect(typeof entry?.personalized).toBe('boolean');
    }
  });

  it('does not register any type outside the C1 vocabulary', () => {
    // The registry keys are EXACTLY the closed vocabulary — no extras a module could smuggle in.
    expect(Object.keys(widgetRegistry).sort()).toEqual([...WIDGET_TYPES].sort());
  });

  it('returns undefined for an unknown / unregistered widget type (⇒ skip)', () => {
    expect(getWidget('not-a-widget')).toBeUndefined();
    expect(getWidget('')).toBeUndefined();
    expect(getWidget('__proto__')).toBeUndefined();
    expect(getWidget('toString')).toBeUndefined();
  });

  it('tags the read-only widgets personalized:false (SEO-visible, cacheable, server-fetched)', () => {
    for (const type of ['star-rating-summary', 'review-list', 'product-carousel'] as const) {
      expect(getWidget(type)?.personalized).toBe(false);
    }
  });

  it('tags the interactive widgets personalized:true (client-island, never server-fetched/cached)', () => {
    for (const type of ['toggle-button', 'submit-form'] as const) {
      expect(getWidget(type)?.personalized).toBe(true);
    }
  });
});

describe('type-safe render dispatchers', () => {
  it('renderReadOnlyWidget renders a read-only descriptor and REFUSES a personalized type', () => {
    const star: WidgetDescriptor = { type: 'star-rating-summary', props: { average: 4, count: 3 } };
    const { container } = render(<>{renderReadOnlyWidget(star)}</>);
    expect(container.querySelector('[data-widget="star-rating-summary"]')).not.toBeNull();

    const toggle: WidgetDescriptor = {
      type: 'toggle-button',
      props: {
        initialOn: false,
        onAction: { path: '/store/v1/modules/m/a' },
        offAction: { path: '/store/v1/modules/m/b' },
        labels: { on: 'on', off: 'off' },
        icon: 'heart',
      },
    };
    // A personalized type must NEVER server-render — the read-only dispatcher returns null.
    expect(renderReadOnlyWidget(toggle)).toBeNull();
  });

  it('renderPersonalizedWidget renders an interactive descriptor and REFUSES a read-only type', () => {
    const toggle: WidgetDescriptor = {
      type: 'toggle-button',
      props: {
        initialOn: false,
        onAction: { path: '/store/v1/modules/wishlist/add' },
        offAction: { path: '/store/v1/modules/wishlist/remove' },
        labels: { on: 'on', off: 'off' },
        icon: 'heart',
      },
    };
    const getAccessToken = () => null;
    const { container } = render(
      <>{renderPersonalizedWidget(toggle, 'wishlist', getAccessToken)}</>,
    );
    expect(container.querySelector('[data-widget="toggle-button"]')).not.toBeNull();

    const star: WidgetDescriptor = { type: 'star-rating-summary', props: { average: 4, count: 3 } };
    expect(renderPersonalizedWidget(star, 'm', getAccessToken)).toBeNull();
  });
});
