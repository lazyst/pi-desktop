// File & folder icons — powered by lucide-react.
// Language-specific file icons use lucide's File as base with a text label overlay.
// Special-purpose icons (shell, docker, env, git, lock, config, markdown) use
// dedicated lucide icons for clearer semantics.

import type { ReactNode } from 'react';
import {
  File,
  Folder,
  FolderOpen,
  FileText,
  FileTerminal,
  FileLock,
  FileCog,
  GitBranch,
  Container,
  KeyRound,
} from 'lucide-react';

interface IconProps {
  size?: number;
}

// ── Folder ────────────────────────────────────────────────────────────────

export function FolderIcon({ size = 14, open = false }: IconProps & { open?: boolean }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} strokeWidth={1.5} color="currentColor" />;
}

// ── Generic file (fallback) ────────────────────────────────────────────────

export function GenericFileIcon({ size = 14 }: IconProps) {
  return <File size={size} strokeWidth={1.5} color="currentColor" />;
}

// ── File with label text (used for most language-specific icons) ──────────
// Renders lucide's File icon as the base shape + a short text badge centered
// on top. The text uses the monospace font so "TS", "JSX", "{}", etc. are
// clearly distinguishable in the file tree.

function LabelFileIcon({ label, size = 14 }: { label: string; size?: number }) {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        lineHeight: 1,
      }}
    >
      <File size={size} strokeWidth={1.5} color="currentColor" />
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: `${Math.max(4.5, size * 0.3)}px`,
          fontFamily: 'var(--font-mono), monospace',
          fontWeight: 700,
          color: 'currentColor',
          lineHeight: 1,
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {label}
      </span>
    </span>
  );
}

// ── Specific icons ────────────────────────────────────────────────────────

export function TypeScriptIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="TS" size={size} />;
}
export function TypeScriptReactIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="TSX" size={size} />;
}
export function JavaScriptIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="JS" size={size} />;
}
export function JavaScriptReactIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="JSX" size={size} />;
}
export function PythonIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="PY" size={size} />;
}
export function JsonIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="{ }" size={size} />;
}
export function CssIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="CSS" size={size} />;
}
export function ScssIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="SC" size={size} />;
}
export function HtmlIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="HTM" size={size} />;
}
export function MarkdownIcon({ size = 14 }: IconProps) {
  return <FileText size={size} strokeWidth={1.5} color="currentColor" />;
}
export function YamlIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="YML" size={size} />;
}
export function TomlIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="TOM" size={size} />;
}
export function ShellIcon({ size = 14 }: IconProps) {
  return <FileTerminal size={size} strokeWidth={1.5} color="currentColor" />;
}
export function RustIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="RS" size={size} />;
}
export function GoIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="GO" size={size} />;
}
export function SqlIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="SQL" size={size} />;
}
export function GraphqlIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="GQL" size={size} />;
}
export function TerraformIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="TF" size={size} />;
}
export function DockerfileIcon({ size = 14 }: IconProps) {
  return <Container size={size} strokeWidth={1.5} color="currentColor" />;
}
export function EnvIcon({ size = 14 }: IconProps) {
  return <KeyRound size={size} strokeWidth={1.5} color="currentColor" />;
}
export function GitIcon({ size = 14 }: IconProps) {
  return <GitBranch size={size} strokeWidth={1.5} color="currentColor" />;
}
export function LockFileIcon({ size = 14 }: IconProps) {
  return <FileLock size={size} strokeWidth={1.5} color="currentColor" />;
}
export function DocFileIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="DOC" size={size} />;
}
export function PdfFileIcon({ size = 14 }: IconProps) {
  return <LabelFileIcon label="PDF" size={size} />;
}
export function ConfigIcon({ size = 14 }: IconProps) {
  return <FileCog size={size} strokeWidth={1.5} color="currentColor" />;
}

// ── Main resolver ─────────────────────────────────────────────────────────

export function getFileIcon(name: string, size = 14): ReactNode {
  const lower = name.toLowerCase();
  const ext = lower.split('.').pop() ?? '';

  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return <DockerfileIcon size={size} />;
  if (lower === '.env' || lower.startsWith('.env.')) return <EnvIcon size={size} />;
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.gitmodules') return <GitIcon size={size} />;
  if (lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'bun.lock' || lower === 'pnpm-lock.yaml' || lower === 'cargo.lock') return <LockFileIcon size={size} />;
  if (lower.endsWith('.config.ts') || lower.endsWith('.config.js') || lower.endsWith('.config.mjs') || lower.endsWith('.config.cjs')) return <ConfigIcon size={size} />;
  if (['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.mjs', 'eslint.config.js'].includes(lower)) return <ConfigIcon size={size} />;

  switch (ext) {
    case 'ts':      return <TypeScriptIcon size={size} />;
    case 'tsx':     return <TypeScriptReactIcon size={size} />;
    case 'js':
    case 'mjs':
    case 'cjs':     return <JavaScriptIcon size={size} />;
    case 'jsx':     return <JavaScriptReactIcon size={size} />;
    case 'py':      return <PythonIcon size={size} />;
    case 'json':
    case 'jsonl':   return <JsonIcon size={size} />;
    case 'css':
    case 'less':    return <CssIcon size={size} />;
    case 'scss':    return <ScssIcon size={size} />;
    case 'html':
    case 'htm':     return <HtmlIcon size={size} />;
    case 'md':
    case 'mdx':     return <MarkdownIcon size={size} />;
    case 'yaml':
    case 'yml':     return <YamlIcon size={size} />;
    case 'toml':    return <TomlIcon size={size} />;
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':    return <ShellIcon size={size} />;
    case 'rs':      return <RustIcon size={size} />;
    case 'go':      return <GoIcon size={size} />;
    case 'sql':     return <SqlIcon size={size} />;
    case 'graphql':
    case 'gql':     return <GraphqlIcon size={size} />;
    case 'tf':
    case 'hcl':     return <TerraformIcon size={size} />;
    case 'docx':    return <DocFileIcon size={size} />;
    case 'pdf':     return <PdfFileIcon size={size} />;
    case 'lock':    return <LockFileIcon size={size} />;
    default:        return <GenericFileIcon size={size} />;
  }
}
