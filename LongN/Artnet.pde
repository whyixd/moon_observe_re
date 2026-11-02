import ch.bildspur.artnet.*;
final String[] IPs = {"2.0.0.101","2.0.0.102","2.0.0.103","2.0.0.104","2.0.0.105"}; 
final int[][] LED_UNIVERSE_GROUP = {{0},{1},{2},{3},{4}};

ArtNetClient artnet;
byte[] dmxData = new byte[512];

void initArtnet()
{
  artnet = new ArtNetClient(null);
  artnet.start();
}

void sendArtnet()
{
  for(int i=0; i<LED_UNIVERSE_GROUP.length;i++)//5
  {
    int arrayIndex;
    for(int j=0; j<LED_UNIVERSE_GROUP[i].length;j++)//1
    {
        int targetNum = LED_UNIVERSE_GROUP[i][j];

        
        arrayIndex = 0;
      
        if(!isRGB[targetNum]){
          
          for(int k=0; k<LED_NUM;k++)
          {
  
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 8 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 16 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k] & 0xFF)*DIM/100);
   

          }
          
          for(int k=0; k<LED_NUM;k++)//for NCTU
          {
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 8 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 16 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1] & 0xFF)*DIM/100);
          }
        }
        else
        {
          for(int k=0; k<LED_NUM;k++)
          {
  
            //println(int(i*groupNum+j)+" "+int(LED_NUM-k-1));
            
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 16 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k]>> 8 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[k] & 0xFF)*DIM/100);
   
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
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 16 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1]>> 8 & 0xFF)*DIM/100);
            dmxData[arrayIndex++] = byte((transLights[targetNum].LedColor_outter[LED_NUM-k-1] & 0xFF)*DIM/100);
          }
        }
        
        if(transLights[targetNum].turnningMode==2)
          dmxData[arrayIndex++]=byte(MAX_DMX_SPEED);
        else if(transLights[targetNum].turnningMode==1)
          dmxData[arrayIndex++]=byte(MID_DMX_SPEED);
        else
          dmxData[arrayIndex++]=byte(0);
          
        if(transLights[targetNum].isClockwise)
          dmxData[arrayIndex++]=byte(0);
        else
          dmxData[arrayIndex++]=byte(255);//255 for reverse
        

        if(isStopping)
        {
          for(int d=0;d<512;d++)dmxData[d]=0;
        }
        //println(dmxData);
        //china box strange setting: U0 for DMX, U1 for SPI
        artnet.unicastDmx(IPs[i], 0, j, dmxData);  //artnet.unicastDmx(IP,subnet,universe,data) 
        artnet.unicastDmx(IPs[i], 0, j+1, dmxData);  //artnet.unicastDmx(IP,subnet,universe,data)
    }
    
  }


}
