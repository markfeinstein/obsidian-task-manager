declare const __TASK_MANAGER_SOURCE_SHA256__: string;
declare const __TASK_MANAGER_SOURCE_SHORT__: string;

export const BUILD_SOURCE_SHA256 = typeof __TASK_MANAGER_SOURCE_SHA256__ === 'string'
  ? __TASK_MANAGER_SOURCE_SHA256__ : 'development';
export const BUILD_SOURCE_SHORT = typeof __TASK_MANAGER_SOURCE_SHORT__ === 'string'
  ? __TASK_MANAGER_SOURCE_SHORT__ : 'development';
export function buildDisplayVersion(version: string): string {
  return BUILD_SOURCE_SHORT === 'development' ? `${version}+src.development` : `${version}+src.${BUILD_SOURCE_SHORT}`;
}
