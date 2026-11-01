import {createContext, createElement, useContext} from "react";
import useSyncProgress from "./useSyncProgress.js";

const SyncProgressContext = createContext({job:null,error:false,lastUpdatedAt:null});
export function SyncProgressProvider({children}) {
  const progress = useSyncProgress();
  return createElement(SyncProgressContext.Provider, {value:progress}, children);
}
export const useSharedSyncProgress = () => useContext(SyncProgressContext);
// A display gate only. Database admission independently checks live state.
export const canEditCatalog = ({job,error}) => !error && job?.editingAllowed === true &&
  job.status === 'SUCCEEDED' && job.progress?.percent === 100;
