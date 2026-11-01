import {historyUiStatus} from '../../shared/history-operation-contract.js';
import {useEffect,useState,useCallback,useRef} from 'react';
import {demoHistory} from '../data/history.demo.js';

const DEMO_MODE=import.meta.env.VITE_HISTORY_DEMO_MODE==='true';
export function normalizeHistoryResponse(data) {
  if(!data||!Array.isArray(data.operations)||data.operations.length>100)throw new Error('History response was incomplete. Try again.');
  const ids=new Set();
  return data.operations.map(row=>{
    if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.title!=='string'||typeof row.type!=='string'||
      typeof row.status!=='string'||!Number.isSafeInteger(row.processedCount)||row.processedCount<0||
      !Number.isSafeInteger(row.totalCount)||row.totalCount<0||!Number.isFinite(Date.parse(row.startedAt)))throw new Error('History response was incomplete. Try again.');
    for(const value of [row.processedCount,row.failedCount,row.uncertainCount]){
      if(value!==undefined&&(!Number.isSafeInteger(value)||value<0||value>row.totalCount))throw new Error('History response was incomplete. Try again.');
    }
    ids.add(row.id);
    return {...row,processed:row.processedCount,total:row.totalCount,status:historyUiStatus(row.status),
      startedLabel:new Date(row.startedAt).toLocaleString()};
  });
}
export default function useHistoryOperations({demoMode=DEMO_MODE}={}) {
  const [operations,setOperations]=useState(demoMode?demoHistory:[]);
  const [loading,setLoading]=useState(!demoMode),[loadingMore,setLoadingMore]=useState(false);
  const [isLive,setIsLive]=useState(false),[error,setError]=useState(null),[hasNextPage,setHasNextPage]=useState(false);
  const request=useRef(null),busy=useRef(false),records=useRef([]),cursor=useRef(null),seen=useRef(new Set());
  const fetchHistory=useCallback(async(append=false)=>{
    if(append&&(busy.current||!cursor.current))return;
    request.current?.abort();
    if(demoMode){setOperations(demoHistory);setIsLive(false);setError(null);setLoading(false);setLoadingMore(false);setHasNextPage(false);return;}
    const controller=new AbortController();request.current=controller;busy.current=true;
    const requestedCursor=append?cursor.current:null;
    if(!append){records.current=[];cursor.current=null;seen.current.clear();setOperations([]);setHasNextPage(false);setIsLive(false);}
    setLoading(!append);setLoadingMore(append);setError(null);
    try {
      const url=requestedCursor?`/api/history?${new URLSearchParams({cursor:requestedCursor})}`:'/api/history';
      const response=await fetch(url,{signal:controller.signal,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('Could not load history. Try again.');
      const data=await response.json(),page=normalizeHistoryResponse(data),info=data.pageInfo;
      if(controller.signal.aborted)return;
      if(!info||typeof info.hasNextPage!=='boolean'||(info.hasNextPage?typeof info.endCursor!=='string'||!info.endCursor||info.endCursor.length>4096||!page.length||seen.current.has(info.endCursor):info.endCursor!==null))throw new Error('History pagination was incomplete. Reload to try again.');
      const loaded=new Set(records.current.map(row=>row.id));
      if(page.some(row=>loaded.has(row.id)))throw new Error('History changed between pages. Reload to try again.');
      if(info.endCursor)seen.current.add(info.endCursor);
      records.current=[...records.current,...page];cursor.current=info.endCursor;
      setOperations(records.current);setHasNextPage(info.hasNextPage);setIsLive(true);
    }catch(cause){
      if(controller.signal.aborted)return;
      setError(cause instanceof Error?cause.message:'Could not load history. Try again.');
      if(!append){setOperations([]);setIsLive(false);}
    }finally{if(!controller.signal.aborted){busy.current=false;setLoading(false);setLoadingMore(false);}}
  },[demoMode]);
  const refetch=useCallback(()=>fetchHistory(false),[fetchHistory]);
  const loadMore=useCallback(()=>fetchHistory(true),[fetchHistory]);
  useEffect(()=>{void refetch();return()=>request.current?.abort();},[refetch]);
  return {operations,loading,loadingMore,hasNextPage,loadMore,isLive,error,isDemo:demoMode,refetch};
}
