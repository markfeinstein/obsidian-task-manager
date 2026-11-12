import type { EventRef, TAbstractFile, Vault } from 'obsidian';

export interface VaultEventHandlers {
  modify(file: TAbstractFile): void;
  create(file: TAbstractFile): void;
  delete(file: TAbstractFile): void;
  rename(file: TAbstractFile, oldPath: string): void;
}

/** Installs one post-layout vault event set; scan/domain policy remains in the host. */
export class VaultEventCoordinator {
  private installed = false;

  constructor(
    private readonly vault: Vault,
    private readonly register: (event: EventRef) => void,
    private readonly handlers: VaultEventHandlers,
  ) {}

  install(): boolean {
    if (this.installed) return false;
    this.installed = true;
    this.register(this.vault.on('modify', (file) => this.handlers.modify(file)));
    this.register(this.vault.on('create', (file) => this.handlers.create(file)));
    this.register(this.vault.on('delete', (file) => this.handlers.delete(file)));
    this.register(this.vault.on('rename', (file, oldPath) => this.handlers.rename(file, oldPath)));
    return true;
  }
}
