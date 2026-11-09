import i18n, { type InitOptions, type TOptions } from "i18next";
import { initReactI18next, useTranslation as useReactI18nextTranslation } from "react-i18next";

import { DEFAULT_LOCALE, i18nextResources, supportedLocales } from "./locales";
import { usageHealthMessages } from "./usage-health";
import { phaseRoutingMessages } from "./phase-routing";
import { monitoringMessages } from "./monitoring";
import { transcriptHistoryMessages } from "./transcript-history";

const i18nextOptions: InitOptions = {
  resources: {
    ...i18nextResources,
    en: { ...i18nextResources.en, phaseRouting: phaseRoutingMessages.en, usageHealth: usageHealthMessages.en, monitoring: monitoringMessages.en, transcriptHistory: transcriptHistoryMessages.en },
    ar: { ...i18nextResources.ar, phaseRouting: phaseRoutingMessages.ar, usageHealth: usageHealthMessages.ar, monitoring: monitoringMessages.ar, transcriptHistory: transcriptHistoryMessages.ar },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: supportedLocales,
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnObjects: false,
  initAsync: false,
};

void i18n.use(initReactI18next).init(i18nextOptions).catch((error: unknown) => {
  console.error("Failed to initialize i18next", error);
});

export function t(key: string, options: TOptions = {}) {
  return i18n.t(key, options);
}

export const useTranslation: typeof useReactI18nextTranslation = useReactI18nextTranslation;
export { i18n };
