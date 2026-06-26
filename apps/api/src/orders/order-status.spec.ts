/**
 * Order state-machine unit tests.
 *
 * Pure tests of the transition map: every legal edge passes, representative illegal
 * edges (backwards, cross-branch, post-terminal) fail, terminal states have no
 * outgoing edges, and self-transitions are illegal except the explicit
 * `partially_refunded → partially_refunded` edge.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import {
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  type OrderStatus,
  canTransition,
  assertTransition,
  isTerminalOrderStatus,
} from './order-status';

const ALL_STATUSES = Object.keys(ORDER_TRANSITIONS) as OrderStatus[];

/** The legal transition edges. */
const LEGAL_EDGES: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  ['pending_payment', 'paid'],
  ['pending_payment', 'cancelled'],
  ['paid', 'fulfilled'],
  ['paid', 'cancelled'],
  ['paid', 'refunded'],
  ['paid', 'partially_refunded'],
  ['fulfilled', 'shipped'],
  ['fulfilled', 'refunded'],
  ['fulfilled', 'partially_refunded'],
  ['shipped', 'delivered'],
  ['shipped', 'refunded'],
  ['shipped', 'partially_refunded'],
  ['delivered', 'completed'],
  ['delivered', 'refunded'],
  ['delivered', 'partially_refunded'],
  ['partially_refunded', 'refunded'],
  ['partially_refunded', 'partially_refunded'],
];

/** Representative illegal edges that must reject. */
const ILLEGAL_EDGES: ReadonlyArray<[OrderStatus, OrderStatus]> = [
  // Backwards / skipping.
  ['delivered', 'pending_payment'],
  ['paid', 'pending_payment'],
  ['shipped', 'paid'],
  ['fulfilled', 'pending_payment'],
  // Skip-ahead (must go step by step).
  ['pending_payment', 'fulfilled'],
  ['pending_payment', 'shipped'],
  ['paid', 'shipped'],
  ['paid', 'delivered'],
  ['fulfilled', 'delivered'],
  ['shipped', 'completed'],
  // Cancel only allowed pre-fulfilment.
  ['fulfilled', 'cancelled'],
  ['shipped', 'cancelled'],
  ['delivered', 'cancelled'],
  // From terminal states — nothing is reachable.
  ['cancelled', 'paid'],
  ['cancelled', 'refunded'],
  ['completed', 'refunded'],
  ['completed', 'delivered'],
  ['refunded', 'partially_refunded'],
  ['refunded', 'paid'],
];

describe('ORDER_TRANSITIONS map', () => {
  it('covers every order_status enum value as a key', () => {
    const expected: OrderStatus[] = [
      'pending_payment',
      'paid',
      'fulfilled',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
      'partially_refunded',
    ];
    expect(new Set(ALL_STATUSES)).toEqual(new Set(expected));
  });

  it('is frozen (the map and each adjacency list)', () => {
    expect(Object.isFrozen(ORDER_TRANSITIONS)).toBe(true);
    for (const status of ALL_STATUSES) {
      expect(Object.isFrozen(ORDER_TRANSITIONS[status])).toBe(true);
    }
  });

  it('only ever targets valid statuses', () => {
    const valid = new Set(ALL_STATUSES);
    for (const status of ALL_STATUSES) {
      for (const to of ORDER_TRANSITIONS[status]) {
        expect(valid.has(to)).toBe(true);
      }
    }
  });
});

describe('canTransition — legal edges', () => {
  it.each(LEGAL_EDGES)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('matches the map exactly (no missing or extra legal edges)', () => {
    const legalSet = new Set(LEGAL_EDGES.map(([f, t]) => `${f}->${t}`));
    const mapSet = new Set<string>();
    for (const from of ALL_STATUSES) {
      for (const to of ORDER_TRANSITIONS[from]) mapSet.add(`${from}->${to}`);
    }
    expect(mapSet).toEqual(legalSet);
  });
});

describe('canTransition — illegal edges', () => {
  it.each(ILLEGAL_EDGES)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe('terminal states', () => {
  it('completed, cancelled, refunded are the terminal set', () => {
    expect(new Set(TERMINAL_ORDER_STATUSES)).toEqual(
      new Set<OrderStatus>(['completed', 'cancelled', 'refunded']),
    );
  });

  it.each(TERMINAL_ORDER_STATUSES)('%s has NO outgoing transitions', (status) => {
    expect(ORDER_TRANSITIONS[status]).toHaveLength(0);
    expect(isTerminalOrderStatus(status)).toBe(true);
  });

  it.each(TERMINAL_ORDER_STATUSES)('%s cannot transition to any status', (status) => {
    for (const to of ALL_STATUSES) {
      expect(canTransition(status, to)).toBe(false);
    }
  });

  it('non-terminal states are not terminal', () => {
    const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_ORDER_STATUSES.includes(s));
    for (const s of nonTerminal) {
      expect(isTerminalOrderStatus(s)).toBe(false);
    }
  });
});

describe('self-transitions', () => {
  it('are illegal for every state EXCEPT partially_refunded', () => {
    for (const status of ALL_STATUSES) {
      const expected = status === 'partially_refunded';
      expect(canTransition(status, status)).toBe(expected);
    }
  });
});

describe('assertTransition', () => {
  it('returns void (does not throw) on a legal edge', () => {
    expect(() => assertTransition('pending_payment', 'paid')).not.toThrow();
    expect(() => assertTransition('partially_refunded', 'partially_refunded')).not.toThrow();
  });

  it('throws UnprocessableEntityException (422) on an illegal edge', () => {
    expect(() => assertTransition('delivered', 'pending_payment')).toThrow(
      UnprocessableEntityException,
    );
    expect(() => assertTransition('cancelled', 'paid')).toThrow(UnprocessableEntityException);
    expect(() => assertTransition('completed', 'refunded')).toThrow(UnprocessableEntityException);
  });

  it('throws on an illegal self-transition', () => {
    expect(() => assertTransition('paid', 'paid')).toThrow(UnprocessableEntityException);
  });

  it('names both states in the error message', () => {
    try {
      assertTransition('shipped', 'paid');
      throw new Error('expected assertTransition to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as Error).message).toContain('shipped');
      expect((err as Error).message).toContain('paid');
    }
  });
});
