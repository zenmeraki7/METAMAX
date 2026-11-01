/** Product-read permission derived only from current server-stored sessions. */
export function hasCurrentProductRead(session){
 const permits=value=>typeof value==='string'&&value.split(',').some(scope=>['read_products','write_products'].includes(scope.trim()));
 return permits(session?.scope)&&(!session.isOnline||permits(session.onlineAccessInfo?.associated_user_scope));
}
/** Mutations require explicit session classification and current staff scope. */
export function hasCurrentProductWrite(session){
 const permits=value=>typeof value==='string'&&value.split(',').some(scope=>scope.trim()==='write_products');
 return (session?.isOnline===false||session?.isOnline===true)&&permits(session.scope)&&
  (!session.isOnline||permits(session.onlineAccessInfo?.associated_user_scope));
}
