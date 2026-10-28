/** My cloud computer (`/api/computer`, plugins/computer/api/routes/computer.ts). */
import { get, post } from '../../api/client';
import type { ComputerView, MyComputerReport } from './model';

export const myComputer = () => get<MyComputerReport>('/api/computer');
export const startComputer = () => post<{ computer: ComputerView; started: boolean }>('/api/computer/start');
export const stopComputer = () => post<{ computer: ComputerView | null }>('/api/computer/stop');
