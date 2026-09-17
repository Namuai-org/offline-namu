import React, {createContext, useContext} from 'react';
import type {AppServices} from './services';

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({services, children}: {services: AppServices; children: React.ReactNode}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

/** Screens talk to controllers and repositories only through this (ARC-001). */
export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error('ServicesProvider is missing');
  }
  return services;
}
