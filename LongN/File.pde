final String STAR_FILE_NAME="point798.txt";
float[][] starPosition = new float[200][3];
int totalStarNum=0;
void readStarPosition()
{
  BufferedReader reader;
  String line;
  reader = createReader(STAR_FILE_NAME);
  

  while(true)
  {

    try {
      line = reader.readLine();
    } catch (IOException e) {
      e.printStackTrace();
      line = null;
      break;
    }
    if (line == null) {
      // Stop reading because of an error or file is empty
      break;
    } 
    else {
      String[] pieces = splitTokens(line, ",");
      if(pieces.length<3) break;
      starPosition[totalStarNum][0] = float(pieces[0])/10;
      starPosition[totalStarNum][1] = -float(pieces[1])/10;
      starPosition[totalStarNum][2] = float(pieces[2])/10+Z_OFFSET;
      
      if(starPosition[totalStarNum][0]<minX)minX=starPosition[totalStarNum][0];
      if(starPosition[totalStarNum][1]<minY)minY=starPosition[totalStarNum][1];
      if(starPosition[totalStarNum][2]<minZ)minZ=starPosition[totalStarNum][2];
      if(starPosition[totalStarNum][0]>maxX)maxX=starPosition[totalStarNum][0];
      if(starPosition[totalStarNum][1]>maxY)maxY=starPosition[totalStarNum][1];
      if(starPosition[totalStarNum][2]>maxZ)maxZ=starPosition[totalStarNum][2];
      
      totalStarNum++;
    }
    //println("");
  }
  println("Total Star:" + totalStarNum);

}

void generateMotorPosition()
{
  PrintWriter fileOutput;
  float w=42.2;
  float h=72;
  int xNumber = 18;
  int yNumber = 3;
  int midX = (xNumber-1)/2;
  int midY = (yNumber-1)/2;
  float xOffset = -859;
  fileOutput = createWriter("/data/"+STAR_FILE_NAME);
  int printNum=0;
  
  for(int x=0;x<xNumber;x++)
  {
    for(int y=0;y<yNumber;y++)
    {
      if(
        (x==0 && y==0) ||
        (x==1 && y==0) ||
        (x%2==0 && y==2)
      )
      {
      }
      else
      {
        fileOutput.print(x*w + xOffset+ ",");  //x
        if(x%2==1){
          fileOutput.print((y-midY)*h + ",");  //y
        }
        else{
          fileOutput.print((y-midY)*h+h/2 + ",");  //y
        }
        fileOutput.print("0");  //z
        fileOutput.println("");
        printNum++;
        
      }
    }
  }
  println(printNum);
  
  fileOutput.println("-84.6,"+(2-midY)*h+",0");
  fileOutput.println("-28.2,"+(2-midY)*h+",0");
  fileOutput.println("28.2,"+(2-midY)*h+",0");
  fileOutput.println("84.6,"+(2-midY)*h+",0");
  printNum+=4;
  
  xOffset = 141.1;
  
  for(int x=0;x<xNumber;x++)
  {
    for(int y=0;y<yNumber;y++)
    {
      if(
        (x==17 && y==0) ||
        (x==16 && y==0) ||
        (x%2==1 && y==2)
      )
      {
      }
      else
      {
        fileOutput.print(x*w + xOffset+ ",");  //x
        if(x%2==0){
          fileOutput.print((y-midY)*h + ",");  //y
        }
        else{
          fileOutput.print((y-midY)*h+h/2 + ",");  //y
        }
        fileOutput.print("0");  //z
        fileOutput.println("");
        printNum++;
      }
    }
  }
  println(printNum);
  fileOutput.close();
}
