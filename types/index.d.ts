/** Panelde açık duran UDF belgesi; hiç açılmadıysa null. */
export type UdfBelge = {
  /** Dosyanın tam yolu. */
  yol: string
  /** Zip içindeki content.xml'den çıkarılan düz metin. */
  metin: string
  /** Metnin satır sayısı. */
  satir: number
} | null

declare module 'claude-code' {
  interface PluginState {
    'udf-onizleme': { belge: UdfBelge }
  }
}
