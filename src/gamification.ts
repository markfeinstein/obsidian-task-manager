export interface GamificationStats {
  totalCompleted: number;
  streakDays: number;
  streakDays7: number;  // Distinct 7-day streaks
  streakDays30: number;  // Distinct 30-day streaks
  streakDays100: number;  // Distinct 100-day streaks
  highPriorityCompleted: number;
  completedToday: number;
  weeklyCompleted: number;
  currentXP: number;  // Current experience points
  currentLevel: number;  // Current level (derived from XP)
  totalXPEarned: number;  // Lifetime XP earned
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  emoji: string;
  condition: (stats: GamificationStats) => boolean;
  points: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-task', name: 'Getting Started', emoji: '🌱', description: 'Complete your first task', condition: (s) => s.totalCompleted >= 1, points: 10 },
  { id: 'ten-tasks', name: 'Productive', emoji: '⚡', description: 'Complete 10 tasks', condition: (s) => s.totalCompleted >= 10, points: 50 },
  { id: 'fifty-tasks', name: 'Hustler', emoji: '💪', description: 'Complete 50 tasks', condition: (s) => s.totalCompleted >= 50, points: 150 },
  { id: 'hundred-tasks', name: 'Centurion', emoji: '💯', description: 'Complete 100 tasks', condition: (s) => s.totalCompleted >= 100, points: 200 },
  { id: 'five-hundred-tasks', name: 'Legend', emoji: '👑', description: 'Complete 500 tasks', condition: (s) => s.totalCompleted >= 500, points: 500 },
  { id: 'streak-3', name: 'On a Roll', emoji: '🔥', description: '3-day completion streak', condition: (s) => s.streakDays >= 3, points: 30 },
  { id: 'streak-7', name: 'Week Warrior', emoji: '⚔️', description: '7-day completion streak', condition: (s) => s.streakDays >= 7, points: 100 },
  { id: 'streak-30', name: 'Iron Discipline', emoji: '💎', description: '30-day completion streak', condition: (s) => s.streakDays >= 30, points: 500 },
  { id: 'streak-100', name: 'Unstoppable', emoji: '⚡', description: '100-day completion streak', condition: (s) => s.streakDays >= 100, points: 1000 },
  { id: 'high-priority', name: 'Fire Fighter', emoji: '🚒', description: 'Complete 5 high-priority tasks', condition: (s) => s.highPriorityCompleted >= 5, points: 75 },
  { id: 'daily-5', name: 'Power Hour', emoji: '🏃', description: 'Complete 5 tasks in one day', condition: (s) => s.completedToday >= 5, points: 40 },
  { id: 'daily-10', name: 'Machine', emoji: '🤖', description: 'Complete 10 tasks in one day', condition: (s) => s.completedToday >= 10, points: 100 },
  { id: 'level-5', name: 'Rising Star', emoji: '⭐', description: 'Reach level 5', condition: (s) => s.currentLevel >= 5, points: 75 },
  { id: 'level-10', name: 'Expert', emoji: '🧠', description: 'Reach level 10', condition: (s) => s.currentLevel >= 10, points: 150 },
  { id: 'level-20', name: 'Master', emoji: '🎓', description: 'Reach level 20', condition: (s) => s.currentLevel >= 20, points: 300 },
];

export function getUnlockedAchievements(stats: GamificationStats): Achievement[] {
  return ACHIEVEMENTS.filter((a) => a.condition(stats));
}

export function calculatePoints(unlockedIds: string[]): number {
  return ACHIEVEMENTS
    .filter((a) => unlockedIds.includes(a.id))
    .reduce((sum, a) => sum + a.points, 0);
}

export function renderAchievements(el: HTMLElement, stats: GamificationStats): void {
  el.empty();
  el.addClass('task-manager-achievements');
  const unlocked = new Set(getUnlockedAchievements(stats).map((a) => a.id));
  const _points = calculatePoints([...unlocked]);

  const header = el.createDiv({ cls: 'task-manager-achievements-header' });
  header.createEl('span', { text: `⭐ Level ${stats.currentLevel}`, cls: 'task-manager-achievements-level', attr: { 'aria-label': `Current level: ${stats.currentLevel}` } });
  const xpBase = getCumulativeXpForLevel(stats.currentLevel);
  const xpProgress = stats.currentXP - xpBase;
  const xpNeeded = getXpForLevel(stats.currentLevel + 1);
  header.createEl('span', { text: `${xpProgress}/${xpNeeded} XP`, cls: 'task-manager-achievements-xp', attr: { 'aria-label': `Experience points: ${xpProgress} of ${xpNeeded}` } });
  header.createEl('span', { text: `${unlocked.size}/${ACHIEVEMENTS.length} 🏆`, cls: 'task-manager-achievements-count' });

  const grid = el.createDiv({ cls: 'task-manager-achievements-grid', attr: { 'aria-label': 'Achievements' } });
  for (const achievement of ACHIEVEMENTS) {
    const badge = grid.createDiv({ cls: 'task-manager-achievement-badge' });
    if (!unlocked.has(achievement.id)) badge.addClass('task-manager-achievement-locked');
    badge.createEl('span', { text: achievement.emoji, cls: 'task-manager-achievement-emoji' });
    badge.createEl('span', { text: achievement.name, cls: 'task-manager-achievement-name' });
    const ariaLabel = unlocked.has(achievement.id) ? `Unlocked: ${achievement.name}` : `Locked: ${achievement.name} - ${achievement.description}`;
    badge.setAttr('title', `${achievement.name}: ${achievement.description} (+${achievement.points}pts)`);
    badge.setAttr('aria-label', ariaLabel);
    badge.setAttr('role', 'img');
  }
}

/**
 * Calculate XP required for a given level
 * Uses exponential formula: baseXP * (1.5 ^ (level - 1))
 */
export function getXpForLevel(level: number): number {
  if (level <= 1) return 0;
  const baseXP = 100;
  return Math.floor(baseXP * Math.pow(1.5, level - 1));
}

/**
 * Calculate level from total XP earned
 */
export function getLevelFromXP(totalXP: number): number {
  let level = 1;
  let cumulativeXP = 0;
  while (cumulativeXP + getXpForLevel(level + 1) <= totalXP) {
    cumulativeXP += getXpForLevel(level + 1);
    level++;
  }
  return level;
}

/**
 * Calculate the cumulative XP required to reach a given level.
 * e.g. getCumulativeXpForLevel(3) = getXpForLevel(2) + getXpForLevel(3)
 * This is the "base" XP at the start of that level.
 */
export function getCumulativeXpForLevel(level: number): number {
  let cumulative = 0;
  for (let l = 2; l <= level; l++) {
    cumulative += getXpForLevel(l);
  }
  return cumulative;
}
