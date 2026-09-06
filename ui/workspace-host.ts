import { AddressBar, type AddressBarPorts } from "./addressbar";
import { FavBar, type FavBarPorts } from "./favbar";
import { Sidebar, type SidebarPorts } from "./sidebar";
import type { WorkspaceSearchOptions } from "./api";
import { FileStatusBar } from "./statusbar";

export interface WorkspaceHostElements {
  topbar: HTMLElement;
  sidebar: HTMLElement;
  favbar: HTMLElement;
  fileStatusbar: HTMLElement;
}

export interface WorkspaceHostPorts {
  addressbar: AddressBarPorts;
  sidebar: SidebarPorts;
  favbar: FavBarPorts;
}

export class WorkspaceHost {
  readonly addressbar: AddressBar;
  readonly sidebar: Sidebar;
  readonly favbar: FavBar;
  readonly fileStatusbar: FileStatusBar;

  constructor(
    elements: WorkspaceHostElements,
    ports: WorkspaceHostPorts,
    searchOptions: WorkspaceSearchOptions,
  ) {
    this.fileStatusbar = new FileStatusBar(elements.fileStatusbar);
    this.addressbar = new AddressBar(elements.topbar, ports.addressbar);
    this.sidebar = new Sidebar(elements.sidebar, ports.sidebar, searchOptions);
    this.favbar = new FavBar(elements.favbar, ports.favbar);
  }
}
