import { create } from "zustand";
import { api, ProviderInput, ProviderItem } from "../lib/api";

interface ProviderState {
  providers: ProviderItem[];
  loaded: boolean;
  refresh: () => Promise<void>;
  save: (input: ProviderInput) => Promise<void>;
  remove: (id: number) => Promise<void>;
  defaultProviderId: number | null;
  setDefaultProvider: (id: number | null) => Promise<void>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  loaded: false,
  defaultProviderId: null,
  refresh: async () => {
    const { providers } = await api.listProviders();
    const saved = await api.getSetting("defaultProviderId");
    set({
      providers,
      loaded: true,
      defaultProviderId: saved ? Number(saved) : null,
    });
  },
  save: async (input) => {
    await api.saveProvider(input);
    await get().refresh();
  },
  remove: async (id) => {
    await api.deleteProvider(id);
    await get().refresh();
  },
  setDefaultProvider: async (id) => {
    await api.setSetting("defaultProviderId", id === null ? "" : String(id));
    set({ defaultProviderId: id });
  },
}));
