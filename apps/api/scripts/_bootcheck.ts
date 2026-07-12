/**
 * 부트 타임 env 검증 확인용(verify-phase65a 가 서브프로세스로 실행).
 * config 를 import 하는 것만으로 env 검증이 돌고, 실패 시 config.ts 가 process.exit(1).
 */
import { config } from "../src/config.js";
console.log("BOOT_OK", config.isProduction);
