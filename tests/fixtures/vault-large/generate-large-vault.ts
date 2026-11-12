/**
 * Large Vault Generator
 * 
 * Generates an exact number of root tasks for performance testing.
 * Optional nesting adds explicit subtasks beyond that root-task count.
 */

export interface LargeVaultOptions {
  taskCount?: number;
  nestingDepth?: number;
  includeMetadata?: boolean;
}

/**
 * Generate markdown content with exactly N root tasks (and optional extra subtasks).
 */
export function generateLargeVault(count: number = 10000, options: LargeVaultOptions = {}): string {
  const { includeMetadata = true, nestingDepth = 0 } = options;
  
  const priorities = ['🔺', '⏫', '🔼', '🔽'];
  const efforts = ['15m', '30m', '1h', '2h', '4h', '8h', '1d', '2d'];
  const dates = generateDateRange(30);
  
  let markdown = '# Large Vault Test\n\nGenerated test vault with thousands of tasks for performance testing.\n\n';
  
  // Create tasks in groups for structure
  const groupSize = 100;
  for (let g = 0; g < Math.ceil(count / groupSize); g++) {
    markdown += `## Group ${g + 1}\n\n`;
    
    const groupStart = g * groupSize;
    const groupEnd = Math.min(groupStart + groupSize, count);
    
    for (let i = groupStart; i < groupEnd; i++) {
      const taskNum = i + 1;
      const status = taskNum % 10 === 0 ? 'x' : ' ';
      const hasNesting = nestingDepth > 0 && i % 5 === 0;
      
      let line = `- [${status}] Task ${taskNum}`;
      
      if (includeMetadata) {
        const priorityIdx = i % priorities.length;
        const effortIdx = i % efforts.length;
        const dateIdx = i % dates.length;
        
        line += ` ${priorities[priorityIdx]}`;
        line += ` 📅 ${dates[dateIdx]}`;
        line += ` ⏱️ ${efforts[effortIdx]}`;
      }
      
      markdown += line + '\n';
      
      // Add nested tasks occasionally
      if (hasNesting && i + 1 < count) {
        for (let j = 0; j < nestingDepth; j++) {
          const subStatus = (i + j) % 3 === 0 ? 'x' : ' ';
          markdown += `  - [${subStatus}] Subtask ${taskNum}.${j + 1}`;
          
          if (includeMetadata && (i + j) % 2 === 0) {
            const subDateIdx = (i + j) % dates.length;
            markdown += ` 📅 ${dates[subDateIdx]}`;
          }
          
          markdown += '\n';
        }
      }
    }
    
    markdown += '\n';
  }
  
  return markdown;
}

/**
 * Generate array of dates for next N days
 */
function generateDateRange(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    dates.push(`${year}-${month}-${day}`);
  }
  
  return dates;
}

/**
 * Generate large vault and write to file
 */
export async function generateLargeVaultFile(
  filePath: string,
  taskCount: number = 10000
): Promise<void> {
  const fs = await import('fs').then(m => m.promises);
  const content = generateLargeVault(taskCount);
  await fs.writeFile(filePath, content, 'utf-8');
}
