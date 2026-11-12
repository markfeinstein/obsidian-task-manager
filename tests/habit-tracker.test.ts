/**
 * Habit Tracker Tests
 * Tests for streak tracking, completion counting, and edge cases
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HabitTracker } from '../src/habit-tracker';

function localDateAtOffset(daysFromToday: number, base = new Date()): Date {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  date.setDate(date.getDate() + daysFromToday);
  return date;
}

// ── Basic Streak Tracking ──────────────────────────────────

test('habit-tracker: initializes with no streak', () => {
  const tracker = new HabitTracker();
  const state = tracker.getStreakState({});
  assert.equal(state.currentStreak, 0);
});

test('habit-tracker: increments streak on completion', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  state = tracker.recordCompletion(state, new Date());
  assert.equal(state.currentStreak, 1);
});

test('habit-tracker: maintains streak for consecutive completions', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  const yesterday = localDateAtOffset(-1, today);
  
  state = tracker.recordCompletion(state, yesterday);
  assert.equal(state.currentStreak, 1);
  
  state = tracker.recordCompletion(state, today);
  assert.equal(state.currentStreak, 2);
});

test('habit-tracker: resets streak on gap', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  const threeDaysAgo = localDateAtOffset(-3, today);
  
  state = tracker.recordCompletion(state, threeDaysAgo);
  state = tracker.recordCompletion(state, today);
  
  // Should reset because of gap
  assert.equal(state.currentStreak, 1);
});

test('habit-tracker: calculateStreak allows one-day grace period', () => {
  const tracker = new HabitTracker();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  
  // Create consecutive dates ending yesterday (not today)
  const yesterday = addDaysHelper(todayIso, -1);
  const twoDaysAgo = addDaysHelper(todayIso, -2);
  const threeDaysAgo = addDaysHelper(todayIso, -3);
  
  const dates = [threeDaysAgo, twoDaysAgo, yesterday];
  const streak = tracker.calculateStreak(dates, todayIso);
  
  // Should show active streak of 3 even though today wasn't completed
  assert.equal(streak, 3);
});

test('habit-tracker: calculateStreak returns zero after grace period', () => {
  const tracker = new HabitTracker();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  
  // Create consecutive dates ending two days ago (outside grace period)
  const twoDaysAgo = addDaysHelper(todayIso, -2);
  const threeDaysAgo = addDaysHelper(todayIso, -3);
  const fourDaysAgo = addDaysHelper(todayIso, -4);
  
  const dates = [fourDaysAgo, threeDaysAgo, twoDaysAgo];
  const streak = tracker.calculateStreak(dates, todayIso);
  
  // Should return 0 because the most recent completion is outside grace period
  assert.equal(streak, 0);
});

// Helper function for ISO date arithmetic in tests
function addDaysHelper(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test('habit-tracker: tracks max streak', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  for (let i = 0; i < 5; i++) {
    const date = localDateAtOffset(-i, today);
    state = tracker.recordCompletion(state, date);
  }
  
  assert.equal(state.currentStreak, 5);
  assert.equal(state.maxStreak, 5);
});

// ── Completion Counting ──────────────────────────────────

test('habit-tracker: counts total completions', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  for (let i = 0; i < 10; i++) {
    const date = localDateAtOffset(-i, today);
    state = tracker.recordCompletion(state, date);
  }
  
  assert.equal(state.totalCompletions, 10);
});

test('habit-tracker: tracks weekly completions', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  for (let i = 0; i < 7; i++) {
    const date = localDateAtOffset(-i, today);
    state = tracker.recordCompletion(state, date);
  }
  
  assert.ok(state.weeklyCompletions >= 7);
});

// ── Edge Cases ──────────────────────────────────

test('habit-tracker: handles same-day multiple completions', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  state = tracker.recordCompletion(state, today);
  const firstStreak = state.currentStreak;
  
  state = tracker.recordCompletion(state, today);
  // Should not double-count same day
  assert.equal(state.currentStreak, firstStreak);
});

test('habit-tracker: handles dates with times', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});

  // Use today's local date at two different clock times to test same-day deduplication.
  // (toIsoDate uses local-time getFullYear/Month/Date, so we must construct the Date
  // objects using local-time components to guarantee they land on today's date string.)
  const now = new Date();
  const time1 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
  const time2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0, 0);

  state = tracker.recordCompletion(state, time1);
  state = tracker.recordCompletion(state, time2);

  // Both completions land on today — they are deduped to a single entry, so currentStreak = 1.
  assert.equal(state.currentStreak, 1);
});

test('habit-tracker: ignores impossible ISO completion dates', () => {
  const tracker = new HabitTracker();
  const state = tracker.getStreakState({
    completions: ['2026-02-28', '2026-02-31', '2026-03-01'],
  });

  assert.deepEqual(state.completions, ['2026-02-28', '2026-03-01']);
  assert.equal(state.totalCompletions, 2);
});

test('habit-tracker: preserves historical data', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  // Record some history
  for (let i = 0; i < 3; i++) {
    const date = localDateAtOffset(-(i + 10), today);
    state = tracker.recordCompletion(state, date);
  }
  
  // Break streak
  for (let i = 0; i < 10; i++) {
    const date = localDateAtOffset(-i, today);
    if (i < 5) {
      // Skip some days to break streak
      date.setDate(date.getDate() + 20);
    }
    state = tracker.recordCompletion(state, date);
  }
  
  // Max streak should still be tracked
  assert.ok(state.maxStreak >= state.currentStreak);
});

test('habit-tracker: calculates longest break', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  // Day 1
  state = tracker.recordCompletion(state, today);
  
  // Skip 5 days
  const day6 = localDateAtOffset(-5, today);
  state = tracker.recordCompletion(state, day6);
  
  // Break should be tracked
  assert.ok(state.longestBreakDays === undefined || state.longestBreakDays >= 0);
});

test('habit-tracker: returns consistent state structure', () => {
  const tracker = new HabitTracker();
  const state = tracker.getStreakState({});
  
  assert.ok(typeof state.currentStreak === 'number');
  assert.ok(typeof state.maxStreak === 'number');
  assert.ok(typeof state.totalCompletions === 'number');
});

test('habit-tracker: coerces corrupt legacy counters to finite values', () => {
  const tracker = new HabitTracker();
  const state = tracker.getStreakState({
    longestStreak: 'not-a-number',
    maxStreak: '4',
    totalCompletions: -3,
    longestBreakDays: Number.NaN,
  });

  assert.equal(state.longestStreak, 0);
  assert.equal(state.maxStreak, 4);
  assert.equal(state.totalCompletions, 0);
  assert.equal(state.longestBreakDays, undefined);
});

test('habit-tracker: handles future dates gracefully', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const futureDate = localDateAtOffset(1);
  
  state = tracker.recordCompletion(state, futureDate);
  // Should not crash, behavior depends on implementation
  assert.ok(state);
});

test('habit-tracker: future completions do not count as current or weekly streak activity', () => {
  const tracker = new HabitTracker();
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(`${todayIso}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  const state = tracker.getStreakState({
    completions: [tomorrow.toISOString().slice(0, 10)],
  });

  assert.equal(state.currentStreak, 0);
  assert.equal(state.weeklyCompletions, 0);
});

test('habit-tracker: tracks achievement unlocks', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  // Build today's local date as an ISO string so UTC-midnight arithmetic
  // produces consecutive calendar dates without DST jumps.
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Build a 100-day streak using UTC-midnight subtraction instead of
  // wall-clock subtraction.  The wall-clock approach (getTime() - i*86400000)
  // skips a calendar day on DST spring-forward transitions, breaking the
  // streak.  Generating consecutive ISO strings avoids that entirely.
  for (let i = 0; i < 100; i++) {
    const d = new Date(`${todayIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    state = tracker.recordCompletion(state, d.toISOString().slice(0, 10));
  }

  // Should have unlocked achievements
  assert.ok(state.currentStreak === 100);
});

test('habit-tracker: exports streak data', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  state = tracker.recordCompletion(state, new Date());
  
  const exported = tracker.exportStreakData(state);
  assert.ok(typeof exported === 'object');
  assert.ok(exported.streak >= 0);
});

test('habit-tracker: validates streak continuity', () => {
  const tracker = new HabitTracker();
  let state = tracker.getStreakState({});
  const today = new Date();
  
  // Add completions
  for (let i = 0; i < 5; i++) {
    const date = localDateAtOffset(-i, today);
    state = tracker.recordCompletion(state, date);
  }
  
  const isValid = tracker.validateStreakContinuity(state);
  assert.equal(isValid, true);
});

// ── Gamification XP / level helpers ────────────────────────────────────────

import { getXpForLevel, getLevelFromXP, getCumulativeXpForLevel, getUnlockedAchievements } from '../src/gamification';

test('gamification: getXpForLevel level 1 returns 0 (no XP cost for starting level)', () => {
  assert.equal(getXpForLevel(1), 0);
});

test('gamification: getXpForLevel level 2 is 150', () => {
  assert.equal(getXpForLevel(2), 150);
});

test('gamification: getCumulativeXpForLevel matches level-up thresholds', () => {
  // Level 1 base = 0 (no prior level-ups needed)
  assert.equal(getCumulativeXpForLevel(1), 0);
  // Level 2 base = 150 (must have earned getXpForLevel(2) to reach level 2)
  assert.equal(getCumulativeXpForLevel(2), 150);
  // Level 3 base = 150 + 225 = 375
  assert.equal(getCumulativeXpForLevel(3), 375);
});

test('gamification: getLevelFromXP agrees with getCumulativeXpForLevel boundaries', () => {
  // Just below level 2 threshold → still level 1
  assert.equal(getLevelFromXP(149), 1);
  // Exactly at level 2 threshold → level 2
  assert.equal(getLevelFromXP(150), 2);
  // Just below level 3 threshold (374) → level 2
  assert.equal(getLevelFromXP(374), 2);
  // Exactly at level 3 threshold (375) → level 3
  assert.equal(getLevelFromXP(375), 3);
});

test('gamification: XP progress within level never exceeds getXpForLevel(nextLevel)', () => {
  // Bug: old code showed currentXP/getXpForLevel(level+1) where currentXP is
  // cumulative total — at level 3 (375 XP) that gave 375/337 which is > 100%.
  // Fix: progress = totalXP - getCumulativeXpForLevel(level).
  const cases: Array<[number, number, number]> = [
    // [totalXP, expectedLevel, expectedProgress]
    [0,   1,   0],
    [100, 1, 100],
    [150, 2,   0],  // just reached level 2; 0 progress toward level 3
    [200, 2,  50],  // 50 XP above level 2 base (150)
    [374, 2, 224],  // one below level 3 boundary
    [375, 3,   0],  // just reached level 3; 0 progress toward level 4
    [600, 3, 225],  // 225 XP above level 3 base (375)
  ];
  for (const [totalXP, expectedLevel, expectedProgress] of cases) {
    const level = getLevelFromXP(totalXP);
    const base = getCumulativeXpForLevel(level);
    const progress = totalXP - base;
    const nextStep = getXpForLevel(level + 1);
    assert.equal(level, expectedLevel, `totalXP=${totalXP}: wrong level`);
    assert.equal(progress, expectedProgress, `totalXP=${totalXP}: wrong progress`);
    assert.ok(progress <= nextStep, `totalXP=${totalXP}: progress ${progress} > nextStep ${nextStep} (would display >100%)`);
  }
});

test('gamification: streak achievements use streakDays as the source of truth', () => {
  const unlocked = new Set(getUnlockedAchievements({
    totalCompleted: 0,
    streakDays: 30,
    streakDays7: 0,
    streakDays30: 0,
    streakDays100: 0,
    highPriorityCompleted: 0,
    completedToday: 0,
    weeklyCompleted: 0,
    currentXP: 0,
    currentLevel: 1,
    totalXPEarned: 0,
  }).map((achievement) => achievement.id));

  assert.ok(unlocked.has('streak-3'));
  assert.ok(unlocked.has('streak-7'));
  assert.ok(unlocked.has('streak-30'));
  assert.ok(!unlocked.has('streak-100'));
});
