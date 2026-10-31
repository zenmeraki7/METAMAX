/** Collision-free resource/field identity; never a field or authorization issuer. */
export const historyMemberKey = identity => JSON.stringify([identity.resourceGid,identity.fieldId]);
export const changeMemberKey = row => historyMemberKey({resourceGid:row.resource_gid,fieldId:row.field_id});
export const requestMembers = request => request.resource_field_set ?? request.resource_fields ?? (request.field_ids ? request.field_ids.map(fieldId=>({
 resourceGid:request.resource_gid,resourceFamilyGid:request.resource_family_gid,fieldId,
})) : []);
