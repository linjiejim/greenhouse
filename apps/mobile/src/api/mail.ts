import type { Mailbox, MailItem, MailDetail, Page } from '../shared/contract';
import { get, post, del, seg } from './client';
const path = (id: string) => `/api/agents/${seg(id)}`;
export const mailbox = (id: string) => get<Mailbox>(`${path(id)}/mailbox`);
export const mail = (id: string, cursor?: string, status?: MailItem['status']) =>
  get<Page<MailItem>>(`${path(id)}/mail`, { cursor, status });
export const mailDetail = (id: string, mailId: string) => get<MailDetail>(`${path(id)}/mail/${seg(mailId)}`);
export const releaseMail = (id: string, mailId: string) => post(`${path(id)}/mail/${seg(mailId)}/release`);
export const addSender = (id: string, address: string) => post<Mailbox>(`${path(id)}/mailbox/senders`, { address });
export const removeSender = (id: string, address: string) =>
  del<Mailbox>(`${path(id)}/mailbox/senders/${seg(address)}`);
