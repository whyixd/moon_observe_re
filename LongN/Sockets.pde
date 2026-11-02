import processing.net.*; 
import hypermedia.net.*;

final int LED_BUFFER_SIZE = LED_NUM*3*2+5+2;//multiply 2 for NCTU an pluse 2 for motor speed and direction
final int STAR_BUFFER_SIZE = 49*3+5;
final int MOTOR_BUFFER_SIZE = MOTOR_NUM+5;

final int[][] STAR_UNIVERSE_GROUP = {{0,1,2,3,4,5,6,
                                      13,12,11,10,9,8,7,
                                      14,15,16,17,18,19,20,
                                      27,26,25,24,23,22,21,
                                      28,29,30,31,32,33,34,
                                      41,40,39,38,37,36,35,
                                      42,43,44,45,46,47,48},
                                     {49,50,51,52,53,54,55,
                                      62,61,60,59,58,57,56,
                                      63,64,65,66,67,68,69,
                                      76,75,74,73,72,71,70,
                                      77,78,79,80,81,82,83,
                                      90,89,88,87,86,85,84},
                                     {91,92,93,94,95,96,97,
                                      104,103,102,101,100,99,98,
                                      105,106,107,108,109,110,111,
                                      118,117,116,115,114,113,112,
                                      119,120,121,122,123,124,125,
                                      132,131,130,129,128,127,126}};
                                      
boolean[] isRGB = {false,false,false,false,false};  //else GRB
byte[] LedControlInfo = new byte[LED_BUFFER_SIZE];
byte LED_LEN_POS = byte((LED_BUFFER_SIZE-4)%256);
byte LED_LEN_PRE = byte((LED_BUFFER_SIZE-4)/256);
byte[] StarControlInfo = new byte[STAR_BUFFER_SIZE];
byte STAR_LEN_POS = byte((STAR_BUFFER_SIZE-4)%256);
byte STAR_LEN_PRE = byte((STAR_BUFFER_SIZE-4)/256);

final int MOTOR_MACHINE = 1;
final int MOTOR_UNIVERSE = 7;
//final int EACH_UNIVERSE_NUM = 23;
//final int MOTOR_BUFFER_SIZE = MOTOR_CHANNEL_NUM*EACH_UNIVERSE_NUM+5;
byte[] MotorControlInfo = new byte[MOTOR_BUFFER_SIZE];
byte MOTOR_LEN_POS = byte((MOTOR_BUFFER_SIZE-4)%256);
byte MOTOR_LEN_PRE = byte((MOTOR_BUFFER_SIZE-4)/256);


UDP myClient;

void initClient() { 
  myClient = new UDP(this); 
} 

void sendLedControlUdp()
{
  if(isSleeping())return;
  

  for(int i=0; i<LED_UNIVERSE_GROUP.length;i++)//1
  {
    int arrayIndex;
    for(int j=0; j<LED_UNIVERSE_GROUP[i].length;j++)//7
    {
      int targetNum = LED_UNIVERSE_GROUP[i][j];

        //GBR chip7 
        LedControlInfo[0] = byte(i);  //Luna Number 
        LedControlInfo[1] = byte(j);  //Universe Number
        LedControlInfo[2] = LED_LEN_POS;
        LedControlInfo[3] = LED_LEN_PRE;
        //LedControlInfo[4] = byte(0);
        arrayIndex = 4;
      
        if(!isRGB[targetNum]){
          
          for(int k=0; k<LED_NUM;k++)
          {
  
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 8 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 16 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k] & 0xFF)*DIM/100);
   

          }
          
          for(int k=0; k<LED_NUM;k++)//for NCTU
          {
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 8 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 16 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1] & 0xFF)*DIM/100);
          }
        }
        else
        {
          for(int k=0; k<LED_NUM;k++)
          {
  
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 16 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 8 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k] & 0xFF)*DIM/100);
   
            /*
            if(LedControlInfo[arrayIndex-3]+LedControlInfo[arrayIndex-2]+LedControlInfo[arrayIndex-1]<3)//filter noise
            {
              LedControlInfo[arrayIndex-3]=0;
              LedControlInfo[arrayIndex-2]=0;
              LedControlInfo[arrayIndex-1]=0;
            }
            */
          }
          for(int k=0; k<LED_NUM;k++)//for NCTU
          {
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 16 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 8 & 0xFF)*DIM/100);
            LedControlInfo[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1] & 0xFF)*DIM/100);
          }
        }
        
        if(transLights[targetNum].turnningMode==2)
          LedControlInfo[arrayIndex++]=byte(MAX_DMX_SPEED);
        else if(transLights[targetNum].turnningMode==1)
          LedControlInfo[arrayIndex++]=byte(MID_DMX_SPEED);
        else
          LedControlInfo[arrayIndex++]=byte(0);
          
        if(transLights[targetNum].isClockwise)
          LedControlInfo[arrayIndex++]=byte(0);
        else
          LedControlInfo[arrayIndex++]=byte(255);//255 for reverse

        while(arrayIndex<LED_BUFFER_SIZE)
        LedControlInfo[arrayIndex++] = 0;
        
        if(!myClient.isClosed()){
          myClient.send(LedControlInfo,"127.0.0.1", 8964);
        }
    }
    
  }
  
}
/*
void sendStarControlUdp()
{
  if(isSleeping())return;
  

  for(int i=0; i<STAR_UNIVERSE_GROUP.length;i++)//6
  {
    //print(i);
    //RBG 
    StarControlInfo[0] = byte(1);  //Luna Number 
    StarControlInfo[1] = byte(i+1);  //Universe Number
    StarControlInfo[2] = STAR_LEN_POS;
    StarControlInfo[3] = STAR_LEN_PRE;
    int arrayIndex = 4;
    
    for(int j=0; j<STAR_UNIVERSE_GROUP[i].length;j++)//
    {
        //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
        
        StarControlInfo[arrayIndex++] = byte((starColor[STAR_UNIVERSE_GROUP[i][j]]>> 16 & 0xFF)*STAR_DIM/100);
        StarControlInfo[arrayIndex++] = byte((starColor[STAR_UNIVERSE_GROUP[i][j]] & 0xFF)*STAR_DIM/100);
        StarControlInfo[arrayIndex++] = byte((starColor[STAR_UNIVERSE_GROUP[i][j]]>> 8 & 0xFF)*STAR_DIM/100);
 
        
        if(LedControlInfo[arrayIndex-3]+LedControlInfo[arrayIndex-2]+LedControlInfo[arrayIndex-1]<3)//filter noise
        {
          LedControlInfo[arrayIndex-3]=0;
          LedControlInfo[arrayIndex-2]=0;
          LedControlInfo[arrayIndex-1]=0;
        }
        
    }
        
    while(arrayIndex<STAR_BUFFER_SIZE)
    StarControlInfo[arrayIndex++] = 0;
    
    if(!myClient.isClosed()){
      myClient.send(StarControlInfo,"127.0.0.1", 8964);
    }
    
  }
  
}
*/
/*
void sendMotorControlUdp()
{
  if(isSleeping())return;
  
  MotorControlInfo[0] = byte(MOTOR_MACHINE);  //Luna Number 
  MotorControlInfo[1] = byte(MOTOR_UNIVERSE);  //Universe Number
  MotorControlInfo[2] = MOTOR_LEN_POS;
  MotorControlInfo[3] = MOTOR_LEN_PRE;
  int arrayIndex = 4;
  for(int i=0; i<MOTOR_NUM;i++)
  {
    if(transLights[i].IsTurnning)
    MotorControlInfo[arrayIndex++]=byte(255);
    else
    MotorControlInfo[arrayIndex++]=byte(0);
    
  }
  
  while(arrayIndex<MOTOR_BUFFER_SIZE)
  MotorControlInfo[arrayIndex++] = 0;
  
  if(!myClient.isClosed()){
    myClient.send(MotorControlInfo,"127.0.0.1", 8964);
  }
}*/
