export type Channel = {
  id:string;
  name:string;
  description:string;
  ownerId:string;
  role:'owner'|'admin'|'member';
  kind?:'channel'|'direct';
  maxParticipants?:number;
  peer?:{id:string;username:string};
};

export const channelCapacity = (channel:Channel) => channel.kind === 'direct' ? 2 : 10;
