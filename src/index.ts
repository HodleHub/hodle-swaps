import WebSocket from 'ws';
import chalk from 'chalk';
import colorize from 'json-colorizer';
import readline from 'readline';

type BalanceNotification = {
  Notif: {
    notif: {
      Balances: {
        balances: Record<string, number>;
      };
    };
  };
}

type NewAddressRequest = {
  Req: {
    id: number;
    req: {
      NewAddress: Record<string, unknown>;
    };
  };
}

type NewAddressResponse = {
  Resp: {
    id: number;
    resp: {
      NewAddress: {
        address: string;
      };
    };
  };
}

type GetQuoteRequest = {
  Req: {
    id: number;
    req: {
      GetQuote: {
        send_asset: string;
        send_amount: number;
        recv_asset: string;
        receive_address: string;
      };
    };
  };
}

type GetQuoteResponse = {
  Resp: {
    id: number;
    resp: {
      GetQuote: {
        quote_id: number;
        recv_amount: number;
        ttl: number;
        txid: string;
      };
    };
  };
}

type AcceptQuoteRequest = {
  Req: {
    id: number;
    req: {
      AcceptQuote: {
        quote_id: number;
      };
    };
  };
}

type AcceptQuoteResponse = {
  Resp: {
    id: number;
    resp: {
      AcceptQuote: {
        txid: string;
      };
    };
  };
}

type GetSwapsRequest = {
  Req: {
    id: number;
    req: {
      GetSwaps: Record<string, unknown>;
    };
  };
};

type Swap = {
  txid: string;
  status: 'NotFound' | 'Mempool' | 'Confirmed';
};

type GetSwapsResponse = {
  Resp: {
    id: number;
    resp: {
      GetSwaps: {
        swaps: Swap[];
      };
    };
  };
}

type ErrorResponse = {
  Error: {
    id: number;
    err: {
      text: string;
      code: string;
      details: unknown;
    };
  };
}

type Message = 
  | BalanceNotification 
  | NewAddressResponse 
  | GetQuoteResponse 
  | AcceptQuoteResponse 
  | GetSwapsResponse
  | ErrorResponse;

let requestId = 1;
let currentAddress: string | null = null;
let balances: Record<string, number> = {};
const activeSwaps: Map<string, Swap> = new Map();
let ws: WebSocket | null = null;
let shouldContinue = true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const logger = {
  info: (message: string) => console.log(chalk.blue('ℹ️ ') + message),
  success: (message: string) => console.log(chalk.green('✅ ') + message),
  warn: (message: string) => console.log(chalk.yellow('⚠️ ') + message),
  error: (message: string) => console.log(chalk.red('❌ ') + message),
  json: (label: string, json: unknown) => {
    console.log(`${chalk.magenta(label)}\n${colorize(JSON.stringify(json, null, 2), { pretty: true })}`);
  },
  balance: (asset: string, amount: number) => {
    console.log(chalk.cyan(`💰 ${asset}:`) + chalk.yellow(` ${amount}`));
  },
  divider: () => console.log(chalk.gray('─'.repeat(80)))
};

const askYesOrNo = async (question: string): Promise<boolean> => {
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`${question} (y/n): `), (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
};

const createWebSocketConnection = (url: string): WebSocket => {
  logger.info(`Connecting to ${chalk.underline(url)}...`);
  ws = new WebSocket(url);
  return ws;
};

const setupEventHandlers = (ws: WebSocket): void => {
  ws.on('open', () => {
    logger.success('Connected to SideSwap');
    logger.divider();
  });

  ws.on('message', (data) => {
    const messageStr = data.toString();
    
    try {
      const message = JSON.parse(messageStr) as Message;
      logger.json('📩 RECEIVED', message);
      handleMessage(message);
      logger.divider();
    } catch (error) {
      logger.error('Error parsing message:');
      console.error(error);
    }
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:');
    console.error(error);
  });

  ws.on('close', () => {
    logger.warn('Disconnected from SideSwap');
  });
};

const hasBalanceForAsset = (asset: string, requiredAmount: number): boolean => {
  const currentBalance = balances[asset] || 0;
  return currentBalance >= requiredAmount;
};

const handleBalancesNotification = async (balancesData: Record<string, number>): Promise<void> => {
  balances = balancesData;
  logger.success('Balances updated:');
  
  if (Object.keys(balances).length === 0) {
    logger.warn('No balances available');
    const shouldRefetch = await askYesOrNo('No balances available. Would you like to refetch?');
    
    if (shouldRefetch && ws) {
      // Wait a bit before refetching
      setTimeout(() => {
        getNewAddress(ws!);
      }, 1000);
    } else {
      shouldContinue = false;
      logger.warn('Operation cancelled by user');
    }
    return;
  }
  
  for (const [asset, amount] of Object.entries(balances)) {
    logger.balance(asset, amount);
  }
};

const handleNewAddressResponse = (address: string): void => {
  currentAddress = address;
  logger.success('New address generated:');
  console.log(chalk.yellow(currentAddress));
};

const handleGetQuoteResponse = (quote: GetQuoteResponse['Resp']['resp']['GetQuote']): void => {
  logger.success('Quote received:');
  console.log(chalk.cyan('Quote ID: ') + chalk.yellow(quote.quote_id.toString()));
  console.log(chalk.cyan('Receive amount: ') + chalk.yellow(quote.recv_amount.toString()));
  console.log(chalk.cyan('TTL: ') + chalk.yellow(`${quote.ttl}s`));
  console.log(chalk.cyan('TXID: ') + chalk.yellow(quote.txid));
};

const handleAcceptQuoteResponse = (acceptedQuote: AcceptQuoteResponse['Resp']['resp']['AcceptQuote']): void => {
  logger.success('Quote accepted:');
  console.log(chalk.cyan('TXID: ') + chalk.yellow(acceptedQuote.txid));
};

const getStatusColor = (status: Swap['status']): Function => {
  const colors = {
    'Confirmed': chalk.green,
    'Mempool': chalk.yellow,
    'NotFound': chalk.red
  };
  
  return colors[status];
};

const handleGetSwapsResponse = (swaps: Swap[]): void => {
  logger.success(`Swaps status (${swaps.length} found):`);
  
  if (swaps.length === 0) {
    logger.warn('No swaps found');
    return;
  }
  
  for (const swap of swaps) {
    activeSwaps.set(swap.txid, swap);
    const statusColor = getStatusColor(swap.status);
    console.log(chalk.cyan('TXID: ') + chalk.gray(swap.txid) + chalk.cyan(' Status: ') + statusColor(swap.status));
  }
};

const handleErrorResponse = (error: ErrorResponse['Error']): void => {
  logger.error(`Error (Request ID: ${error.id}):`);
  console.log(chalk.red(error.err.text));
  console.log(chalk.yellow(`Error code: ${error.err.code}`));
  if (error.err.details) {
    logger.json('Error details:', error.err.details);
  }
};

const handleResponseMessage = (resp: any): void => {
  if ('NewAddress' in resp.resp) {
    handleNewAddressResponse(resp.resp.NewAddress.address);
    return;
  }
  
  if ('GetQuote' in resp.resp) {
    handleGetQuoteResponse(resp.resp.GetQuote);
    return;
  }
  
  if ('AcceptQuote' in resp.resp) {
    handleAcceptQuoteResponse(resp.resp.AcceptQuote);
    return;
  }
  
  if ('GetSwaps' in resp.resp) {
    handleGetSwapsResponse(resp.resp.GetSwaps.swaps);
    return;
  }
};

const handleMessage = (message: Message): void => {
  if ('Notif' in message) {
    if ('Balances' in message.Notif.notif) {
      handleBalancesNotification(message.Notif.notif.Balances.balances);
    }
    return;
  } 
  
  if ('Resp' in message) {
    handleResponseMessage(message.Resp);
    return;
  } 
  
  if ('Error' in message) {
    handleErrorResponse(message.Error);
    return;
  }
};

const sendMessage = (ws: WebSocket, message: unknown): void => {
  const messageString = JSON.stringify(message);
  logger.json('📤 SENDING', message);
  ws.send(messageString);
};

const getNewAddress = (ws: WebSocket): void => {
  const request: NewAddressRequest = {
    Req: {
      id: requestId++,
      req: {
        NewAddress: {}
      }
    }
  };
  logger.info('Requesting new address...');
  sendMessage(ws, request);
};

const getQuote = async (ws: WebSocket, sendAsset: string, sendAmount: number, recvAsset: string, receiveAddress: string): Promise<void> => {
  if (!hasBalanceForAsset(sendAsset, sendAmount)) {
    logger.error(`Insufficient balance for ${sendAsset}. Required: ${sendAmount}, Available: ${balances[sendAsset] || 0}`);
    
    const shouldRefetch = await askYesOrNo('Would you like to refetch balances?');
    if (shouldRefetch) {
      getNewAddress(ws);
      return;
    }
    
    logger.warn('Operation cancelled due to insufficient balance');
    return;
  }
  
  const request: GetQuoteRequest = {
    Req: {
      id: requestId++,
      req: {
        GetQuote: {
          send_asset: sendAsset,
          send_amount: sendAmount,
          recv_asset: recvAsset,
          receive_address: receiveAddress
        }
      }
    }
  };
  logger.info(`Requesting quote: ${chalk.yellow(sendAmount.toString())} ${chalk.cyan(sendAsset)} ➡️ ${chalk.cyan(recvAsset)}`);
  sendMessage(ws, request);
};

const acceptQuote = (ws: WebSocket, quoteId: number): void => {
  const request: AcceptQuoteRequest = {
    Req: {
      id: requestId++,
      req: {
        AcceptQuote: {
          quote_id: quoteId
        }
      }
    }
  };
  logger.info(`Accepting quote: ${chalk.yellow(quoteId.toString())}`);
  sendMessage(ws, request);
};

const getSwaps = (ws: WebSocket): void => {
  const request: GetSwapsRequest = {
    Req: {
      id: requestId++,
      req: {
        GetSwaps: {}
      }
    }
  };
  logger.info('Checking swaps status...');
  sendMessage(ws, request);
};

const getCurrentAddress = (): string | null => currentAddress;

const processSwap = async (ws: WebSocket): Promise<void> => {
  const address = getCurrentAddress();
  if (!address) {
    logger.error('No address available. Please generate an address first.');
    return;
  }
  
  // Example asset and amount - adjust as needed
  const sendAsset = 'DePix';
  const sendAmount = 1;
  const recvAsset = 'L-BTC';
  
  if (!hasBalanceForAsset(sendAsset, sendAmount)) {
    logger.warn(`No ${sendAsset} balance available at address ${address}`);
    const shouldRefetch = await askYesOrNo('Would you like to refetch balances?');
    
    if (shouldRefetch) {
      getNewAddress(ws);
      return;
    }
    
    logger.warn('Operation cancelled by user');
    shouldContinue = false;
    return;
  }
  
  logger.success(`Found sufficient balance for ${sendAsset}. Proceeding with swap...`);
  await getQuote(ws, sendAsset, sendAmount, recvAsset, address);
};

const main = async (): Promise<void> => {
  const ws = createWebSocketConnection('ws://127.0.0.1:3102');
  setupEventHandlers(ws);
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  getNewAddress(ws);

  setTimeout(async () => {
    if (shouldContinue) {
      await processSwap(ws);
      
      setTimeout(() => {
        if (shouldContinue) {
          getSwaps(ws);
        }
      }, 10000);
    }
  }, 5000);
};

main().catch(error => {
  logger.error('Application error:');
  console.error(error);
}).finally(() => {
  setTimeout(() => {
    rl.close();
  }, 30000);
});