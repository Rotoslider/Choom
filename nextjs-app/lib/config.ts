/**
 * Centralized path configuration.
 * All workspace/skill paths should be imported from here.
 */
import path from 'path';
import os from 'os';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(os.homedir(), 'choom-projects');
export const CUSTOM_SKILLS_ROOT = path.join(WORKSPACE_ROOT, '.choom-skills');
export const EXTERNAL_SKILLS_ROOT = path.join(WORKSPACE_ROOT, '.choom-external-skills');

// Workspace write policy (moved verbatim out of app/api/chat/route.ts, C-22).
export const WORKSPACE_MAX_FILES_PER_SESSION = 50;
export const WORKSPACE_MAX_FILE_SIZE_KB = 1024;
export const WORKSPACE_ALLOWED_EXTENSIONS = [
  // Documents & data
  '.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.log', '.rst', '.tex', '.bib', '.diff', '.patch',
  // Web & scripting
  '.py', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.scss', '.sass', '.less', '.graphql', '.gql',
  // Shell & system
  '.sh', '.bash', '.ps1', '.bat', '.cmd', '.conf', '.rules', '.service',
  // Config
  '.yaml', '.yml', '.xml', '.sql', '.toml', '.ini', '.cfg', '.env.example',
  // Notebooks
  '.r', '.R', '.ipynb',
  // Systems programming
  '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.pl', '.lua', '.m',
  // LISP family
  '.lisp', '.lsp', '.cl', '.asd', '.el', '.scm', '.ss', '.rkt', '.clj', '.cljs', '.cljc', '.edn',
  // Microcontroller & embedded
  '.ino', '.pde', '.s', '.S', '.asm', '.ld', '.dts', '.dtsi', '.kconfig', '.mk',
  // FPGA
  '.v', '.sv', '.tcl',
  // Build & infra
  '.proto', '.cmake', '.makefile', '.dockerfile', '.tf', '.hcl',
  // ROS2
  '.msg', '.srv', '.action', '.urdf', '.xacro', '.sdf', '.world', '.rviz', '.repos',
];
export const WORKSPACE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
export const WORKSPACE_DOWNLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx', '.zip', '.tar', '.gz', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sh', '.bash', '.sql', '.r', '.R', '.ipynb', '.lisp', '.lsp', '.cl', '.asd', '.el', '.scm', '.ss', '.rkt', '.clj', '.cljs', '.cljc', '.edn'];
