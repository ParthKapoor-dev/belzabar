import Table from 'cli-table3';
import chalk from 'chalk';

type DisplayMode = 'HUMAN' | 'LLM';

export class DisplayManager {
  private static mode: DisplayMode = 'HUMAN';

  static configure(options: { llm: boolean }) {
    if (options.llm) {
      this.mode = 'LLM';
    }
  }

  static get isLLM() {
    return this.mode === 'LLM';
  }

  static info(message: string) {
    if (this.mode === 'HUMAN') {
      console.info(chalk.blue(`[Info] ${message}`));
    }
  }

  static success(message: string) {
    if (this.mode === 'HUMAN') {
      console.log(chalk.green(`✅ ${message}`));
    }
  }

  static error(error: any) {
    if (this.mode === 'HUMAN') {
      const msg = error.message || error;
      console.error(chalk.red(`❌ Error: ${msg}`));
      if (error.stack && process.env.VERBOSE) {
        console.error(chalk.gray(error.stack));
      }
    } else {
      console.log(JSON.stringify({ error: error.message || String(error) }));
    }
  }

  static table(headers: string[], rows: any[][]) {
    if (this.mode === 'HUMAN') {
      const table = new Table({
        head: headers,
        wordWrap: true
      });
      table.push(...rows);
      console.log(table.toString());
    } else {
      const data = rows.map(row => {
        const obj: any = {};
        headers.forEach((h, i) => {
          if (row[i] !== undefined && row[i] !== null && row[i] !== "") {
            obj[h] = row[i];
          }
        });
        return obj;
      });
      console.log(JSON.stringify(data));
    }
  }

  static object(data: any) {
    if (this.mode === 'HUMAN') {
      console.dir(data, { depth: null, colors: true });
    } else {
      console.log(JSON.stringify(data));
    }
  }

  static kv(key: string, value: any) {
     if (this.mode === 'HUMAN') {
         console.log(`${chalk.bold(key)}: ${value}`);
     } else {
         console.log(JSON.stringify({ [key]: value }));
     }
  }
}
