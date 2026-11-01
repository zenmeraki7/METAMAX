import {useEffect,useState} from 'react';
import {validateProductCapabilities} from '../services/product-capabilities.js';
export default function useProductCapabilities(snapshotId,revision,refresh) {
  const [fields,setFields]=useState([]);
  useEffect(()=>{
    setFields([]);if(!snapshotId||!revision)return;
    const controller=new AbortController();
    void (async()=>{
      try {
        const response=await fetch('/api/catalog/capabilities',{signal:controller.signal,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error('Capabilities unavailable');
        const value=await response.json();
        const fields=validateProductCapabilities(value,snapshotId,revision);
        if(!controller.signal.aborted)setFields(fields);
      }catch{if(!controller.signal.aborted)setFields([]);}
    })();
    return()=>controller.abort();
  },[snapshotId,revision,refresh]);
  return fields;
}
