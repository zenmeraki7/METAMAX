import {Readable} from "node:stream";
import assert from "node:assert/strict";
export function versionedS3TestTransport() {
  const objects=new Map();let version=0;
  return {objects,async send(command) {
    const input=command.input;
    if(command.constructor.name==="GetBucketVersioningCommand")return {Status:"Enabled"};
    if(command.constructor.name==="GetPublicAccessBlockCommand")return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    if(command.constructor.name==="PutObjectCommand") {
      assert.equal(input.IfNoneMatch,"*");
      let bytes;
      if(Buffer.isBuffer(input.Body))bytes=Buffer.from(input.Body);
      else {const chunks=[];for await(const chunk of input.Body)chunks.push(Buffer.from(chunk));bytes=Buffer.concat(chunks);}
      assert.equal(bytes.length,input.ContentLength);
      const VersionId=String(++version);objects.set(`${input.Key}:${VersionId}`,bytes);return {VersionId};
    }
    if(command.constructor.name==="GetObjectCommand") {
      const bytes=objects.get(`${input.Key}:${input.VersionId}`);if(!bytes)throw Error("Missing test object version");
      return {VersionId:input.VersionId,Body:Readable.from([bytes]),ContentLength:bytes.length};
    }
    throw Error(`Unexpected test S3 command ${command.constructor.name}`);
  }};
}
