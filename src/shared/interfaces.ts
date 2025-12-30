// Shared interfaces to avoid circular dependencies between modules

export interface ProductionQueryInterface {
  maChuyenLine?: string;
  factory?: string;
  line?: string;
  team?: string;
  shift?: number;
}

export interface ProductionDataInterface {
  maChuyenLine: string;
  factory: string;
  data: any[];
  summary: any;
  totalRecords: number;
  lastUpdate: string;
}

export interface TVDisplayQueryInterface {
  code?: string;
  factory?: string;
  line?: string;
  team?: string;
}